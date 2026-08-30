import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RestrictedCicdTargetJournalError,
  canonicalizeRestrictedCicdReceipt,
  createRestrictedCicdTargetJournal,
  loadRestrictedCicdReceiptTrustPolicy,
  signRestrictedCicdTargetReceipt,
  verifyRestrictedCicdTargetReceiptSignature,
} from "../lib/restricted-cicd-target-journal.ts";

const sha = (letter) => letter.repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentnovas-target-journal-"));
  await chmod(root, 0o700);
  return { root, journal: await createRestrictedCicdTargetJournal(root) };
}

const lockInput = {
  environment: "staging",
  operationId: "operation-target-1",
  commandId: "command-target-1",
  ownerEpoch: 1,
  ownerIdentitySha256: sha("1"),
};

function checkpoint(phase, overrides = {}) {
  return {
    phase,
    evidenceSha256: sha("2"),
    recordedAt: new Date("2026-08-27T11:00:00.000Z"),
    actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: null,
    ...overrides,
  };
}

test("durable target mutex serializes an environment and crash residue fails closed", async () => {
  const { root, journal } = await fixture();
  let release;
  let locked;
  const acquired = new Promise((resolve) => { locked = resolve; });
  const held = journal.withEnvironmentLock(lockInput, async () => {
    locked();
    return new Promise((resolve) => { release = resolve; });
  });
  try {
    await acquired;
    await assert.rejects(
      journal.withEnvironmentLock({ ...lockInput, operationId: "operation-target-2" }, async () => undefined),
      (error) => error instanceof RestrictedCicdTargetJournalError && error.code === "TARGET_MUTEX_BUSY",
    );
  } finally {
    release();
    await held;
    await rm(root, { recursive: true, force: true });
  }
});

test("stop intent is durably single-flight while the environment mutex is busy", async () => {
  const { root, journal } = await fixture();
  const request = {
    schemaVersion: "1", stopId: "stop-pending-target-1", environment: "staging",
    actorKind: "break_glass", actorIdentity: "offline-security-1",
    reason: "Persist emergency containment until the cutover mutex releases",
  };
  try {
    const queued = await journal.enqueueLocalStopRequest({
      request, actorFingerprintSha256: sha("a"),
      requestedAt: new Date("2026-08-27T11:00:00.000Z"),
    });
    assert.equal(queued.replayed, false);
    assert.equal((await journal.enqueueLocalStopRequest({
      request, actorFingerprintSha256: sha("a"),
      requestedAt: new Date("2026-08-27T11:00:01.000Z"),
    })).replayed, true);
    await assert.rejects(journal.enqueueLocalStopRequest({
      request: { ...request, stopId: "stop-pending-target-2" },
      actorFingerprintSha256: sha("a"), requestedAt: new Date("2026-08-27T11:00:02.000Z"),
    }), (error) => error.code === "TARGET_LOCAL_STOP_ALREADY_PENDING");
    const pending = await journal.listPendingLocalStopRequests("staging");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.stopId, request.stopId);
    await journal.removePendingLocalStopRequest(pending[0]);
    assert.deepEqual(await journal.listPendingLocalStopRequests("staging"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal persists strict phase order, owner fencing and exact checkpoint replay", async () => {
  const { root, journal } = await fixture();
  try {
    await journal.withEnvironmentLock(lockInput, async (session) => {
      const prepared = await session.append(checkpoint("prepared"));
      assert.equal(prepared.replayed, false);
      const replay = await session.append(checkpoint("prepared"));
      assert.equal(replay.replayed, true);
      await session.append(checkpoint("applying", { recordedAt: new Date("2026-08-27T11:00:01.000Z") }));
      await session.append(checkpoint("cutover_intent_durable", {
        recordedAt: new Date("2026-08-27T11:00:02.000Z"),
      }));
      await session.append(checkpoint("cutover_committed", {
        recordedAt: new Date("2026-08-27T11:00:03.000Z"),
        actualCurrentReleaseVersionId: "release-target-1",
      }));
      const verified = await session.append(checkpoint("health_verified", {
        recordedAt: new Date("2026-08-27T11:00:04.000Z"),
        actualCurrentReleaseVersionId: "release-target-1",
      }));
      assert.equal(verified.journal.sequence, 5);
    });
    await assert.rejects(journal.withEnvironmentLock({ ...lockInput, ownerEpoch: 2 }, async (session) => {
      await session.append(checkpoint("health_verified", {
        recordedAt: new Date("2026-08-27T11:00:04.000Z"),
        actualCurrentReleaseVersionId: "release-target-1",
      }));
    }), /owner epoch stale/);
    const stored = await readFile(join(root, "operations", "operation-target-1.json"), "utf8");
    assert.doesNotMatch(stored, /oidc|token|privateKey/i);
    assert.equal(JSON.parse(stored).checkpoints.at(-1).phase, "health_verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery requires stopped-owner proof and a database-fenced epoch takeover", async () => {
  const { root, journal } = await fixture();
  let leaveCrashResidue;
  const crashed = journal.withEnvironmentLock(lockInput, async (session) => {
    await session.append(checkpoint("prepared"));
    return new Promise((resolve) => { leaveCrashResidue = resolve; });
  });
  try {
    while (!leaveCrashResidue) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(journal.takeoverAndWithEnvironmentLock({
      environment: "staging",
      operationId: "operation-target-1",
      commandId: "command-target-1",
      expectedOwnerEpoch: 1,
      newOwnerEpoch: 2,
      newOwnerIdentitySha256: sha("3"),
      evidenceSha256: sha("4"),
      reason: "The previous process identity was authoritatively confirmed stopped",
      now: new Date("2026-08-27T11:00:05.000Z"),
    }, {
      confirmPreviousOwnerStopped: async () => false,
      authorizeTakeover: async () => assert.fail("must not authorize a live-owner takeover"),
    }, async () => undefined), (error) => error.code === "TARGET_PREVIOUS_OWNER_LIVE");

    // Simulate the prior process dying without executing its finally block.
    leaveCrashResidue();
    await crashed;
    const lockDir = join(root, "locks", "staging.lock");
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(lockDir, { mode: 0o700 })
      .then(() => writeFile(join(lockDir, "owner.json"), `${JSON.stringify({
        schemaVersion: "1",
        environment: "staging",
        operationId: "operation-target-1",
        ownerEpoch: 1,
        ownerIdentitySha256: sha("1"),
        processId: 999999,
        processIdentitySha256: sha("9"),
        acquiredAt: "2026-08-27T11:00:00.000Z",
      })}\n`, { mode: 0o600 })));
    let authorizeCalls = 0;
    await journal.takeoverAndWithEnvironmentLock({
      environment: "staging",
      operationId: "operation-target-1",
      commandId: "command-target-1",
      expectedOwnerEpoch: 1,
      newOwnerEpoch: 2,
      newOwnerIdentitySha256: sha("3"),
      evidenceSha256: sha("4"),
      reason: "The previous process identity was authoritatively confirmed stopped",
      now: new Date("2026-08-27T11:00:05.000Z"),
    }, {
      confirmPreviousOwnerStopped: async (owner) => owner.ownerEpoch === 1,
      authorizeTakeover: async () => {
        authorizeCalls += 1;
        return { ownerEpoch: 2, replayed: false };
      },
    }, async (session) => {
      await session.append(checkpoint("applying", {
        recordedAt: new Date("2026-08-27T11:00:06.000Z"),
      }));
    });
    assert.equal(authorizeCalls, 1);
    const stored = await journal.load("operation-target-1");
    assert.equal(stored.currentOwnerEpoch, 2);
    assert.equal(stored.ownershipTransfers.length, 1);
    assert.equal(stored.checkpoints.at(-1).ownerEpoch, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup removes only its own process-proven stale mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentnovas-target-stale-lock-"));
  await chmod(root, 0o700);
  const journal = await createRestrictedCicdTargetJournal(root, {
    processId: 12345,
    processIdentitySha256: sha("8"),
    isProcessAlive: async () => false,
  });
  const lockDirectory = join(root, "locks", "staging.lock");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
    schemaVersion: "1", environment: "staging", operationId: "operation-stale-1",
    ownerEpoch: 1, ownerIdentitySha256: sha("1"), processId: 99999,
    processIdentitySha256: sha("9"), acquiredAt: "2026-08-27T11:00:00.000Z",
  })}\n`, { mode: 0o600 });
  try {
    await assert.rejects(journal.recoverOwnedStaleLock("staging", sha("2")),
      (error) => error.code === "TARGET_TAKEOVER_REQUIRED");
    assert.equal(await journal.recoverOwnedStaleLock("staging", sha("1")), true);
    assert.equal(await journal.recoverOwnedStaleLock("staging", sha("1")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live owner is not reclaimed and release uses exact owner CAS", async () => {
  const { root, journal } = await fixture();
  // Model Linux /proc liveness explicitly so the ownership contract is also
  // deterministic on macOS development hosts.
  const second = await createRestrictedCicdTargetJournal(root,{
    isProcessAlive: async (lock) => lock.processId === process.pid,
  });
  let entered;
  let allowReplacement;
  const acquired = new Promise((resolve) => { entered = resolve; });
  const replace = new Promise((resolve) => { allowReplacement = resolve; });
  const held = journal.withEnvironmentMutex(lockInput, async () => {
    entered();
    await replace;
    const replacement = {
      schemaVersion: "1", environment: "staging", operationId: "operation-target-2",
      ownerEpoch: 2, ownerIdentitySha256: sha("3"), processId: process.pid,
      processIdentitySha256: sha("4"), acquiredAt: "2026-08-27T11:00:05.000Z",
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "locks", "staging.lock", "owner.json"), `${JSON.stringify(replacement)}\n`, {
      mode: 0o600,
    });
  });
  try {
    await acquired;
    await assert.rejects(second.recoverOwnedStaleLock("staging", sha("1")),
      (error) => error.code === "TARGET_PREVIOUS_OWNER_LIVE");
    allowReplacement();
    await assert.rejects(held, (error) => error.code === "TARGET_OWNER_STALE");
    const persisted = JSON.parse(await readFile(join(root, "locks", "staging.lock", "owner.json"), "utf8"));
    assert.equal(persisted.operationId, "operation-target-2");
  } finally {
    allowReplacement?.();
    await held.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Ed25519 receipt signs deterministic canonical payload and rejects mutation", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity = {
    commandId: "command-target-1",
    releaseVersionId: "release-target-1",
    runId: "778899",
    runAttempt: 1,
    oidcJtiSha256: sha("3"),
    authorizationNonce: "authorization-nonce-1",
    operationId: "operation-target-1",
    environment: "staging",
    action: "deploy",
    workflowSha256: sha("4"),
    artifactManifestSha256: sha("5"),
    snapshotSha256: sha("6"),
    environmentGeneration: 1,
    expectedCurrentReleaseVersionId: null,
  };
  const signed = signRestrictedCicdTargetReceipt({
    identity,
    imageDigests: {
      client: sha("7"),
      operations: sha("8"),
      maintenance: sha("9"),
      runtime: sha("a"),
    },
    migrationRegistrySha256: sha("b"),
    backupId: "backup-target-1",
    journalPhase: "health_verified",
    journalSequence: 5,
    ownerEpoch: 1,
    startedAt: new Date("2026-08-27T11:00:00.000Z"),
    completedAt: new Date("2026-08-27T11:00:04.000Z"),
    actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: "release-target-1",
    receiptNonce: "receipt-target-1",
    keyId: "receipt-key-1",
    privateKey,
  });
  assert.match(signed.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyRestrictedCicdTargetReceiptSignature(signed.payload, signed.signature, publicKey), true);
  assert.equal(verifyRestrictedCicdTargetReceiptSignature(
    { ...signed.payload, actualCurrentReleaseVersionId: "release-evil" }, signed.signature, publicKey,
  ), false);
  assert.equal(
    canonicalizeRestrictedCicdReceipt({ b: 2, a: { d: 4, c: 3 } }),
    canonicalizeRestrictedCicdReceipt({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("receipt signing rejects non-publishable internal journal phases", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(() => signRestrictedCicdTargetReceipt({
    identity: {
      commandId: "command-target-1", releaseVersionId: "release-target-1", runId: "778899",
      runAttempt: 1, oidcJtiSha256: sha("3"), authorizationNonce: "authorization-nonce-1",
      operationId: "operation-target-1", environment: "staging", action: "deploy",
      workflowSha256: sha("4"), artifactManifestSha256: sha("5"), snapshotSha256: sha("6"),
      environmentGeneration: 1, expectedCurrentReleaseVersionId: null,
    },
    imageDigests: { client: sha("7"), operations: sha("8"),
      maintenance: sha("9"), runtime: sha("a") },
    migrationRegistrySha256: sha("b"), backupId: null, journalPhase: "applying",
    journalSequence: 1, ownerEpoch: 1, startedAt: new Date("2026-08-27T11:00:00.000Z"),
    completedAt: new Date("2026-08-27T11:00:01.000Z"), actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: null, receiptNonce: "receipt-target-1", keyId: "receipt-key-1",
    privateKey,
  }), (error) => error.code === "TARGET_RECEIPT_INVALID");
});

test("receipt trust policy binds lifecycle and rejects compromised signing keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-receipt-trust-"));
  await chmod(root, 0o700);
  const { publicKey } = generateKeyPairSync("ed25519");
  const spkiSha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const publicKeySpkiBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const file = join(root, "trust.json");
  const policy = {
    schemaVersion: "1", algorithm: "Ed25519", canonicalization: "agentnovas-canonical-json-v1",
    keys: [{
      keyId: "receipt-key-1", spkiSha256, publicKeySpkiBase64,
      notBefore: "2026-08-01T00:00:00.000Z", notAfter: "2026-09-01T00:00:00.000Z",
      revokedAt: null, compromisedAt: null,
    }],
  };
  try {
    await writeFile(file, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
    const loaded = await loadRestrictedCicdReceiptTrustPolicy(
      file, publicKey, "receipt-key-1", new Date("2026-08-27T00:00:00.000Z"),
    );
    assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(loaded.verificationPublicKeyFor(
      "receipt-key-1", new Date("2026-08-27T00:00:00.000Z"),
    ).asymmetricKeyType, "ed25519");
    await writeFile(file, `${JSON.stringify({
      ...policy,
      keys: [{ ...policy.keys[0], compromisedAt: "2026-08-20T00:00:00.000Z" }],
    })}\n`, { mode: 0o600 });
    await assert.rejects(loadRestrictedCicdReceiptTrustPolicy(
      file, publicKey, "receipt-key-1", new Date("2026-08-27T00:00:00.000Z"),
    ), (error) => error.code === "TARGET_RECEIPT_KEY_INACTIVE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
