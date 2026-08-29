import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeRestrictedCicdTargetClearAcknowledgement,
  executeRestrictedCicdTargetClearCommit,
  executeRestrictedCicdTargetOperation,
  executeRestrictedCicdTargetStop,
} from "../lib/restricted-cicd-target-engine.ts";
import { createRestrictedCicdTargetJournal } from "../lib/restricted-cicd-target-journal.ts";

const sha = (letter) => letter.repeat(64);
const identity = {
  commandId: "command-target-1", releaseVersionId: "release-target-1", runId: "778899",
  runAttempt: 1, oidcJtiSha256: sha("1"), authorizationNonce: "authorization-target-1",
  operationId: "operation-target-1", environment: "staging", action: "deploy",
  workflowSha256: sha("2"), artifactManifestSha256: sha("3"), snapshotSha256: sha("4"),
  environmentGeneration: 1, expectedCurrentReleaseVersionId: null,
};
const material = {
  releaseTag: "v1.2.3", releaseCommitSha: "a".repeat(40),
  imageDigests: { client: sha("5"), operations: sha("6"), maintenance: sha("7"), runtime: sha("8") },
  migrationSetSha256: sha("9"), migrationVersion: "0082_restricted_cicd_journal_sequence",
  hasIrreversibleMigrations: false,
};

async function fixture(overrides = {}, databaseOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "target-engine-"));
  await chmod(root, 0o700);
  const receiptCalls = [];
  const adapterCalls = [];
  const database = {
    appendReceipt: async (value) => {
      receiptCalls.push(value);
      return { receiptId: value.receiptId, replayed: false };
    },
    assertMigrationRegistry: async () => ({ migrationRegistrySha256: material.migrationSetSha256, migrationCount: 83 }),
    validateAuthority: async () => ({ releaseVersionId: identity.releaseVersionId }),
    validateCutover: async () => ({ releaseVersionId: identity.releaseVersionId, validatedAt: new Date() }),
    ...databaseOverrides,
  };
  const adapter = {
    prepare: async () => { adapterCalls.push("prepare"); },
    createBackup: async () => { adapterCalls.push("backup"); return {
      backupId: "backup-operation-target-1", replayed: false, backupSha256: sha("b"),
      restoreTocSha256: sha("d"), restorePlanSha256: sha("c"), createdAt: new Date(),
    }; },
    applyMigrations: async () => { adapterCalls.push("migrate"); },
    probeDesired: async () => { adapterCalls.push("probe"); return { matched: adapterCalls.includes("cutover") }; },
    probePhysicalDesired: async () => ({ matched: adapterCalls.includes("cutover") }),
    commitMarker: async () => { adapterCalls.push("marker"); },
    cutover: async () => { adapterCalls.push("cutover"); },
    healthCheck: async () => { adapterCalls.push("health"); return true; },
    ...overrides,
  };
  const keys = generateKeyPairSync("ed25519");
  let tick = 0;
  const journal = await createRestrictedCicdTargetJournal(root);
  return { root, journal, execute: () => executeRestrictedCicdTargetOperation({
    identity, material, ownerEpoch: 1, ownerIdentitySha256: sha("a"), database,
    journal, adapter, receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
    receiptKeyId: "receipt-key-1", now: () => new Date(1_800_000_000_000 + tick++ * 1_000),
    targetBindingSha256: sha("d"), receiptTrustSha256: sha("e"),
  }), receiptCalls, adapterCalls, database, adapter, keys };
}

test("engine persists real checkpoint sequences and replays receipts without repeating cutover", async () => {
  const context = await fixture();
  try {
    assert.deepEqual(await context.execute(), { phase: "health_verified", replayed: false });
    assert.deepEqual(context.receiptCalls.map((call) => call.signed.payload.journalSequence), [4, 5]);
    const persisted = await context.journal.load(identity.operationId);
    assert.deepEqual(persisted.checkpoints.map((item) => item.phase), [
      "prepared", "applying", "cutover_intent_durable", "cutover_committed", "health_verified",
    ]);
    assert.deepEqual(Object.keys(persisted.receipts).sort(), [
      "operation-target-1-receipt-cutover_committed",
      "operation-target-1-receipt-health_verified",
    ]);
    const sideEffects = [...context.adapterCalls];
    assert.deepEqual(await context.execute(), { phase: "health_verified", replayed: true });
    assert.deepEqual(context.adapterCalls, sideEffects);
    assert.deepEqual(context.receiptCalls.map((call) => call.signed.payload.journalSequence), [4, 5, 4, 5]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("persisted signed receipt replays with its historical verification key after rotation", async () => {
  let databaseOnline = false;
  const persisted = [];
  const context = await fixture({}, {
    appendReceipt: async (value) => {
      if (!databaseOnline) throw new Error("database unavailable after local receipt commit");
      persisted.push(value);
      return { receiptId: value.receiptId, replayed: false };
    },
  });
  const rotated = generateKeyPairSync("ed25519");
  try {
    await assert.rejects(context.execute(), /database unavailable/);
    assert.equal((await context.journal.load(identity.operationId)).receipts[
      "operation-target-1-receipt-cutover_committed"
    ].payload.keyId, "receipt-key-1");
    databaseOnline = true;
    const result = await executeRestrictedCicdTargetOperation({
      identity, material, ownerEpoch: 1, ownerIdentitySha256: sha("a"),
      database: context.database, journal: context.journal, adapter: context.adapter,
      receiptPrivateKey: rotated.privateKey,
      receiptPublicKeyFor: (keyId) => keyId === "receipt-key-1"
        ? context.keys.publicKey : rotated.publicKey,
      receiptKeyId: "receipt-key-2", targetBindingSha256: sha("d"), receiptTrustSha256: sha("e"),
      now: () => new Date(1_800_000_010_000),
    });
    assert.deepEqual(result, { phase: "health_verified", replayed: false });
    assert.deepEqual(persisted.map((item) => item.signed.payload.keyId), [
      "receipt-key-1", "receipt-key-2",
    ]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("migration uncertainty blocks before cutover and emits a signed terminal receipt", async () => {
  const context = await fixture({ applyMigrations: async () => { throw new Error("fixture failure"); } });
  try {
    assert.deepEqual(await context.execute(), { phase: "uncertain_before_cutover", replayed: false });
    assert.equal(context.receiptCalls.length, 1);
    assert.equal(context.receiptCalls[0].signed.payload.journalPhase, "uncertain_before_cutover");
    assert.equal(context.adapterCalls.includes("cutover"), false);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("expired final authority fails before migration or cutover", async () => {
  const context = await fixture({}, {
    validateAuthority: async () => { throw new Error("expired fixture authority"); },
  });
  try {
    assert.deepEqual(await context.execute(), { phase: "failed_before_cutover", replayed: false });
    assert.equal(context.adapterCalls.includes("prepare"), false);
    assert.equal(context.adapterCalls.includes("migrate"), false);
    assert.equal(context.adapterCalls.includes("cutover"), false);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

for (const recoveryPhase of ["applying", "cutover_intent_durable"]) {
  test(`expired ${recoveryPhase} recovery performs no new deployment side effect`, async () => {
    const context = await fixture({}, {
      validateAuthority: async () => { throw new Error("expired fixture authority"); },
    });
    try {
      await context.journal.withOperationLock({
        environment: identity.environment, operationId: identity.operationId, commandId: identity.commandId,
        ownerEpoch: 1, ownerIdentitySha256: sha("a"),
      }, async (session) => {
        const phases = recoveryPhase === "applying"
          ? ["prepared", "applying"] : ["prepared", "applying", "cutover_intent_durable"];
        for (const [index, phase] of phases.entries()) {
          await session.append({
            phase, evidenceSha256: sha(String(index + 1)),
            recordedAt: new Date(1_800_000_000_000 + index * 1_000),
            actualPreviousReleaseVersionId: null, actualCurrentReleaseVersionId: null,
          });
        }
      });
      assert.deepEqual(await context.execute(), { phase: "uncertain_before_cutover", replayed: false });
      assert.equal(context.adapterCalls.includes("prepare"), false);
      assert.equal(context.adapterCalls.includes("backup"), false);
      assert.equal(context.adapterCalls.includes("migrate"), false);
      assert.equal(context.adapterCalls.includes("cutover"), false);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });
}

test("cutover error recovers a complete physical switch and repairs the marker", async () => {
  let physical = false;
  const context = await fixture({
    cutover: async () => { context.adapterCalls.push("cutover"); physical = true; throw new Error("lost response"); },
    probeDesired: async () => ({ matched: false }),
    probePhysicalDesired: async () => ({ matched: physical }),
    commitMarker: async () => { context.adapterCalls.push("marker"); },
  });
  try {
    assert.deepEqual(await context.execute(), { phase: "health_verified", replayed: false });
    assert.ok(context.adapterCalls.includes("marker"));
    assert.deepEqual(context.receiptCalls.map((call) => call.signed.payload.journalPhase), [
      "cutover_committed", "health_verified",
    ]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("unprovable physical state is signed as post-cutover uncertainty without inventing current", async () => {
  const context = await fixture({
    cutover: async () => { context.adapterCalls.push("cutover"); throw new Error("partial switch"); },
    probeDesired: async () => ({ matched: false }),
    probePhysicalDesired: async () => ({ matched: false }),
  });
  try {
    assert.deepEqual(await context.execute(), { phase: "uncertain_after_cutover", replayed: false });
    assert.equal(context.receiptCalls[0].signed.payload.actualCurrentReleaseVersionId, null);
    assert.equal(context.receiptCalls[0].signed.payload.journalPhase, "uncertain_after_cutover");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("stop and cutover contend on the same durable environment mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-stop-race-"));
  await chmod(root, 0o700);
  const journal = await createRestrictedCicdTargetJournal(root);
  const keys = generateKeyPairSync("ed25519");
  const stopRequest = {
    schemaVersion: "1", stopId: "stop-target-race-1", environment: "staging",
    actorKind: "user", actorIdentity: "release-operator-1", reason: "Stop wins only after the active cutover mutex releases",
  };
  let release;
  let acquired;
  const locked = new Promise((resolve) => { acquired = resolve; });
  const held = journal.withEnvironmentLock({
    environment: "staging", operationId: identity.operationId, commandId: identity.commandId,
    ownerEpoch: 1, ownerIdentitySha256: sha("a"),
  }, async () => {
    acquired();
    return new Promise((resolve) => { release = resolve; });
  });
  const database = {
    requestStop: async () => ({
      generation: 2, expectedCurrentReleaseVersionId: identity.releaseVersionId,
      requestedAt: new Date("2026-08-27T12:00:00.000Z"), replayed: false,
    }),
    appendStopReceipt: async ({ receiptId }) => ({ receiptId, replayed: false }),
  };
  const executeStop = (request = stopRequest, actorFingerprintSha256 = sha("b")) => executeRestrictedCicdTargetStop({
    request, actorFingerprintSha256, ownerIdentitySha256: sha("a"),
    database, journal, receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
    receiptKeyId: "receipt-key-1", receiptTrustSha256: sha("c"),
  });
  try {
    await locked;
    await assert.rejects(executeStop(), (error) => error.code === "TARGET_MUTEX_BUSY");
    const pending = await journal.listPendingLocalStopRequests("staging");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.stopId, stopRequest.stopId);
    release();
    await held;
    assert.deepEqual(await executeStop(pending[0].request, pending[0].actorFingerprintSha256), {
      phase: "stop_committed", generation: 2, authorizationEpoch: 1,
      pendingBackfill: false, replayed: false,
    });
    assert.deepEqual(await journal.listPendingLocalStopRequests("staging"), []);
  } finally {
    if (release) release();
    await held.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("stop commits during long migration and wins the final cutover mutex", async () => {
  let enterMigration;
  let releaseMigration;
  const migrating = new Promise((resolve) => { enterMigration = resolve; });
  const resume = new Promise((resolve) => { releaseMigration = resolve; });
  const context = await fixture({
    applyMigrations: async () => {
      context.adapterCalls.push("migrate");
      enterMigration();
      await resume;
    },
  });
  const keys = generateKeyPairSync("ed25519");
  const deploy = context.execute();
  try {
    await migrating;
    const stop = await executeRestrictedCicdTargetStop({
      request: {
        schemaVersion: "1", stopId: "stop-during-migration-1", environment: "staging",
        actorKind: "break_glass", actorIdentity: "offline-security-1",
        reason: "Emergency stop must preempt the not-yet-started cutover",
      },
      actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: {
        requestStop: async () => ({
          generation: 2, expectedCurrentReleaseVersionId: null,
          requestedAt: new Date("2026-08-27T12:00:00.000Z"), replayed: false,
        }),
        appendStopReceipt: async ({ receiptId }) => ({ receiptId, replayed: false }),
      },
      journal: context.journal,
      receiptPrivateKey: keys.privateKey,
      receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1",
      receiptTrustSha256: sha("c"),
    });
    assert.equal(stop.phase, "stop_committed");
    releaseMigration();
    assert.deepEqual(await deploy, { phase: "stop_committed", replayed: false });
    assert.equal(context.adapterCalls.includes("cutover"), false);
  } finally {
    releaseMigration?.();
    await deploy.catch(() => undefined);
    await rm(context.root, { recursive: true, force: true });
  }
});

test("break-glass remains sticky when the platform database is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-break-glass-offline-"));
  await chmod(root, 0o700);
  const journal = await createRestrictedCicdTargetJournal(root);
  const keys = generateKeyPairSync("ed25519");
  try {
    const result = await executeRestrictedCicdTargetStop({
      request: {
        schemaVersion: "1", stopId: "stop-offline-platform-1", environment: "production",
        actorKind: "break_glass", actorIdentity: "offline-security-1",
        reason: "Platform database is unavailable during emergency containment",
      },
      actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: { requestStop: async () => { throw new Error("database unavailable"); } },
      journal,
      receiptPrivateKey: keys.privateKey,
      receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1",
      receiptTrustSha256: sha("c"),
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });
    assert.deepEqual(result, {
      phase: "stop_committed", generation: 1, authorizationEpoch: 1,
      pendingBackfill: true, replayed: false,
    });
    assert.equal(journal.isLocalStopActive(await journal.loadLocalStop("production")), true);
    const pending = await journal.listPendingLocalStopBackfills("production");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].stopId, "stop-offline-platform-1");
    await assert.rejects(executeRestrictedCicdTargetStop({
      request: {
        schemaVersion: "1", stopId: "stop-offline-platform-2", environment: "production",
        actorKind: "break_glass", actorIdentity: "offline-security-2",
        reason: "A second stop cannot replace the uncleared local stop authority",
      },
      actorFingerprintSha256: sha("d"), ownerIdentitySha256: sha("a"),
      database: { requestStop: async () => { throw new Error("database unavailable"); } }, journal,
      receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1", receiptTrustSha256: sha("c"),
    }), (error) => error.code === "TARGET_LOCAL_STOP_ALREADY_ACTIVE");
    assert.equal((await journal.listPendingLocalStopBackfills("production"))[0].stopId,
      "stop-offline-platform-1");
    await assert.rejects(executeRestrictedCicdTargetStop({
      request: {
        schemaVersion: "1", stopId: "stop-offline-platform-1", environment: "production",
        actorKind: "break_glass", actorIdentity: "offline-security-1",
        reason: "The same identifier cannot be replayed with a changed emergency reason",
      },
      actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: { requestStop: async () => { throw new Error("database unavailable"); } }, journal,
      receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1", receiptTrustSha256: sha("c"),
    }), (error) => error.code === "TARGET_LOCAL_STOP_REPLAY_MISMATCH");
    assert.deepEqual(await journal.listPendingLocalStopRequests("production"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop and clear acknowledgement replay exact signed bytes across response loss and key rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-stop-receipt-rotation-"));
  await chmod(root, 0o700);
  const journal = await createRestrictedCicdTargetJournal(root);
  const oldKeys = generateKeyPairSync("ed25519");
  const newKeys = generateKeyPairSync("ed25519");
  const stoppedAt = new Date("2026-08-27T12:00:00.000Z");
  const stopRequest = {
    schemaVersion: "1", stopId: "stop-receipt-rotation-1", environment: "staging",
    actorKind: "user", actorIdentity: "release-operator-1",
    reason: "Persist exact stop receipts before accepting database acknowledgement",
  };
  const reservation = {
    generation: 2, expectedCurrentReleaseVersionId: null, requestedAt: stoppedAt, replayed: false,
  };
  let stopAccepted;
  let stopResponseLost = true;
  const stopDatabase = {
    requestStop: async () => reservation,
    appendStopReceipt: async (input) => {
      stopAccepted ??= input.signed;
      assert.deepEqual(input.signed, stopAccepted);
      if (stopResponseLost) {
        stopResponseLost = false;
        throw new Error("database committed stop receipt but response was lost");
      }
      return { receiptId: input.receiptId, replayed: true };
    },
  };
  try {
    assert.equal((await executeRestrictedCicdTargetStop({
      request: stopRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: stopDatabase, journal, receiptPrivateKey: oldKeys.privateKey,
      receiptPublicKeyFor: () => oldKeys.publicKey,
      receiptKeyId: "receipt-key-old", receiptTrustSha256: sha("c"), now: () => stoppedAt,
    })).pendingBackfill, true);
    const replayedStop = await executeRestrictedCicdTargetStop({
      request: stopRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: { ...stopDatabase, requestStop: async () => ({ ...reservation, replayed: true }) }, journal,
      receiptPrivateKey: newKeys.privateKey,
      receiptPublicKeyFor: (keyId) => keyId === "receipt-key-old" ? oldKeys.publicKey : newKeys.publicKey,
      receiptKeyId: "receipt-key-new", receiptTrustSha256: sha("c"),
      now: () => new Date("2026-08-27T12:01:00.000Z"),
    });
    assert.equal(replayedStop.pendingBackfill, false);
    assert.equal(stopAccepted.payload.keyId, "receipt-key-old");

    const clearRequest = {
      schemaVersion: "1", stopId: stopRequest.stopId, environment: "staging", generation: 2,
      activationId: "activation-receipt-rotation-1", expectedCurrentReleaseVersionId: null,
      actorIdentity: "release-operator-1", reason: "Replay the exact clear acknowledgement after key rotation",
    };
    let clearAccepted;
    let clearResponseLost = true;
    const clearDatabase = {
      prepareClearAcknowledgement: async () => ({ stopRequestedAt: stoppedAt }),
      appendStopReceipt: async (input) => {
        clearAccepted ??= input.signed;
        assert.deepEqual(input.signed, clearAccepted);
        if (clearResponseLost) {
          clearResponseLost = false;
          throw new Error("database committed clear acknowledgement but response was lost");
        }
        return { receiptId: input.receiptId, replayed: true };
      },
    };
    await assert.rejects(executeRestrictedCicdTargetClearAcknowledgement({
      request: clearRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: clearDatabase, journal, receiptPrivateKey: oldKeys.privateKey,
      receiptPublicKeyFor: () => oldKeys.publicKey,
      receiptKeyId: "receipt-key-old", receiptTrustSha256: sha("c"),
    }), /response was lost/);
    const clearReplay = await executeRestrictedCicdTargetClearAcknowledgement({
      request: clearRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: clearDatabase, journal, receiptPrivateKey: newKeys.privateKey,
      receiptPublicKeyFor: (keyId) => keyId === "receipt-key-old" ? oldKeys.publicKey : newKeys.publicKey,
      receiptKeyId: "receipt-key-new", receiptTrustSha256: sha("c"),
    });
    assert.equal(clearReplay.replayed, true);
    assert.equal(clearAccepted.payload.keyId, "receipt-key-old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local stop clears only after target ack and platform dual-control clear commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-stop-clear-"));
  await chmod(root, 0o700);
  const journal = await createRestrictedCicdTargetJournal(root);
  const keys = generateKeyPairSync("ed25519");
  const stoppedAt = new Date("2026-08-27T12:00:00.000Z");
  const clearedAt = new Date("2026-08-27T12:05:00.000Z");
  const stopRequest = {
    schemaVersion: "1", stopId: "stop-clear-lifecycle-1", environment: "staging",
    actorKind: "user", actorIdentity: "release-operator-1",
    reason: "Stop before validating the dual-control clear lifecycle",
  };
  const clearRequest = {
    schemaVersion: "1", stopId: stopRequest.stopId, environment: "staging", generation: 2,
    activationId: "activation-after-stop-1", expectedCurrentReleaseVersionId: null,
    actorIdentity: "release-operator-1", reason: "A separate checker approved clearing the sticky stop",
  };
  try {
    await executeRestrictedCicdTargetStop({
      request: stopRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: {
        requestStop: async () => ({
          generation: 2, expectedCurrentReleaseVersionId: null, requestedAt: stoppedAt, replayed: false,
        }),
        appendStopReceipt: async ({ receiptId }) => ({ receiptId, replayed: false }),
      },
      journal, receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1", receiptTrustSha256: sha("c"), now: () => stoppedAt,
    });
    const acknowledged = await executeRestrictedCicdTargetClearAcknowledgement({
      request: clearRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: {
        prepareClearAcknowledgement: async () => ({ stopRequestedAt: stoppedAt }),
        appendStopReceipt: async ({ receiptId }) => ({ receiptId, replayed: false }),
      },
      journal, receiptPrivateKey: keys.privateKey, receiptPublicKeyFor: () => keys.publicKey,
      receiptKeyId: "receipt-key-1", receiptTrustSha256: sha("c"),
    });
    assert.equal(acknowledged.phase, "clear_acknowledged");
    assert.equal(journal.isLocalStopActive(await journal.loadLocalStop("staging")), true);
    const committed = await executeRestrictedCicdTargetClearCommit({
      request: clearRequest, actorFingerprintSha256: sha("b"), ownerIdentitySha256: sha("a"),
      database: { validateStopCleared: async () => ({
        clearedGeneration: 3, expectedCurrentReleaseVersionId: null, clearedAt,
      }) },
      journal, receiptPrivateKey: keys.privateKey, receiptKeyId: "receipt-key-1",
      receiptTrustSha256: sha("c"),
    });
    assert.deepEqual(committed, { phase: "clear_committed", generation: 3, replayed: false });
    assert.equal(journal.isLocalStopActive(await journal.loadLocalStop("staging")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
