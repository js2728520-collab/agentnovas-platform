import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  RestrictedCicdTargetError,
  createRestrictedCicdTargetDatabase,
  parseRestrictedCicdTargetRequest,
  parseRestrictedCicdWorkflowTargetRequest,
  parseRestrictedCicdTargetStopRequest,
  verifyRestrictedCicdGithubOidcToken,
} from "../lib/restricted-cicd-target.ts";
import {
  signRestrictedCicdStopReceipt,
  signRestrictedCicdTargetReceipt,
} from "../lib/restricted-cicd-target-journal.ts";
import {
  computeRestrictedCicdProviderBindingSha256,
  parseRestrictedCicdGithubBinding,
} from "../lib/restricted-cicd-github.ts";

const sha = (letter) => letter.repeat(64);
const commit = (letter) => letter.repeat(40);
const bindingInput = {
  provider: "github_actions",
  apiVersion: "2026-03-10",
  apiBaseUrl: "https://api.github.com",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "123456789",
  appId: "24680",
  installationId: "13579",
  accountId: "11223344",
  appPrivateKeyFile: "/run/credentials/worker/app.pem",
  workflowId: "99887766",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: commit("a"),
  workflowSha256: sha("b"),
  environment: "staging",
  oidcAudience: "https://deploy.agentnovas.internal",
  runnerEnvironment: "github-hosted",
  g7ManifestSha256: sha("c"),
  providerBindingSha256: sha("d"),
  environmentPolicySha256: sha("e"),
  productionReviewerAllowlistSha256: sha("f"),
  runnerPolicySha256: sha("1"),
  targetBindingSha256: sha("2"),
  receiptTrustSha256: sha("3"),
  auditorTrustSha256: sha("4"),
};
bindingInput.providerBindingSha256 = computeRestrictedCicdProviderBindingSha256(bindingInput);
const binding = parseRestrictedCicdGithubBinding(bindingInput);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "github-oidc-test-key";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const jwks = { keys: [jwk] };
const now = new Date("2026-08-27T10:00:00.000Z");
const executionSnapshot = {
  schemaVersion: "1", snapshotSha256: sha("7"), commandId: "command-target-1",
  releaseVersionId: "release-target-1", environment: "staging", action: "deploy",
  releaseTag: "v1.2.3", releaseCommitSha: commit("d"),
  imageDigests: { client: sha("1"), operations: sha("2"), maintenance: sha("3"), runtime: sha("4") },
  artifactManifestSha256: sha("8"), migrationSetSha256: sha("9"),
  migrationVersion: "0081_restricted_cicd_exact_target_request", hasIrreversibleMigrations: false,
  controlCommitSha: commit("a"), workflowId: binding.workflowId, workflowPath: binding.workflowPath,
  workflowSha256: binding.workflowSha256, environmentGeneration: 3,
  expectedCurrentReleaseVersionId: null, stagingReceiptSha256: null,
  rollbackEvidenceSha256: null, rollbackEvidenceExpiresAt: null,
  g7ActivationId: "activation-target-1", g7ActivationSha256: sha("a"),
  firstProductionEnablementId: null, firstProductionEnablementSha256: null,
  environmentPolicySha256: sha("b"), runnerPolicySha256: sha("c"),
  reviewerAllowlistSha256: sha("d"), receiptTrustSha256: sha("e"), auditorTrustSha256: sha("f"),
  makerUserId: "maker-target-1", checkerUserId: "checker-target-1",
  reason: "Approved exact target deployment fixture",
  createdAt: "2026-08-27T09:55:00.000Z", approvedAt: "2026-08-27T09:56:00.000Z",
  expiresAt: "2026-08-27T10:05:00.000Z",
};

function claims(overrides = {}) {
  const seconds = Math.floor(now.getTime() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: binding.oidcAudience,
    sub: "repo:agentnovas/platform:environment:staging",
    exp: seconds + 300,
    iat: seconds - 10,
    nbf: seconds - 10,
    jti: "github-jti-target-0001",
    ref: binding.workflowControlRef,
    sha: binding.controlCommitSha,
    repository: "agentnovas/platform",
    repository_id: binding.repositoryId,
    repository_owner: "agentnovas",
    repository_owner_id: binding.accountId,
    repository_visibility: "private",
    run_id: "778899",
    run_attempt: "1",
    workflow_ref: `agentnovas/platform/${binding.workflowPath}@${binding.workflowControlRef}`,
    workflow_sha: binding.controlCommitSha,
    event_name: "workflow_dispatch",
    environment: "staging",
    runner_environment: "github-hosted",
    check_run_id: "445566",
    ...overrides,
  };
}

function token(payload = claims(), header = { alg: "RS256", kid, typ: "JWT" }) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}

function request(overrides = {}) {
  return {
    schemaVersion: "1",
    authorizationId: "authorization-target-1",
    operationId: "operation-target-1",
    commandId: "command-target-1",
    attemptKey: "attempt-target-1",
    attestationId: "attestation-target-1",
    authorizationNonce: "authorization-nonce-1",
    expiresAt: "2026-08-27T10:04:00.000Z",
    providerRunId: "778899",
    jobId: "445566",
    environment: "staging",
    action: "deploy",
    snapshotSha256: sha("7"),
    artifactManifestSha256: sha("8"),
    workflowSha256: binding.workflowSha256,
    environmentGeneration: 3,
    expectedCurrentReleaseVersionId: null,
    oidcToken: token(),
    ...overrides,
  };
}

test("GitHub OIDC verification binds signature, immutable run, environment, workflow and jti", () => {
  const verified = verifyRestrictedCicdGithubOidcToken({
    token: token(), jwks, binding, providerRunId: "778899", jobId: "445566", environment: "staging", now,
  });
  assert.deepEqual({
    providerRunId: verified.providerRunId,
    jobId: verified.jobId,
    environment: verified.environment,
  }, { providerRunId: "778899", jobId: "445566", environment: "staging" });
  assert.match(verified.jtiSha256, /^[a-f0-9]{64}$/);
  assert.match(verified.claimsSha256, /^[a-f0-9]{64}$/);

  const immutableSub = "repo:agentnovas@11223344/platform@123456789:environment:staging";
  assert.doesNotThrow(() => verifyRestrictedCicdGithubOidcToken({
    token: token(claims({ sub: immutableSub })), jwks, binding,
    providerRunId: "778899", jobId: "445566", environment: "staging", now,
  }));
});

test("OIDC rejects rerun, wrong audience/ref/job, reusable workflow and unknown key", () => {
  for (const payload of [
    claims({ run_attempt: "2" }),
    claims({ aud: "https://wrong.invalid" }),
    claims({ ref: "refs/tags/other" }),
    claims({ check_run_id: "445567" }),
    claims({ job_workflow_ref: "agentnovas/shared/.github/workflows/deploy.yml@main" }),
  ]) {
    assert.throws(() => verifyRestrictedCicdGithubOidcToken({
      token: token(payload), jwks, binding,
      providerRunId: "778899", jobId: "445566", environment: "staging", now,
    }), (error) => error instanceof RestrictedCicdTargetError && error.code === "OIDC_CLAIMS_MISMATCH");
  }
  assert.throws(() => verifyRestrictedCicdGithubOidcToken({
    token: token(), jwks: { keys: [{ ...jwk, kid: "other" }] }, binding,
    providerRunId: "778899", jobId: "445566", environment: "staging", now,
  }), /key set invalid/);
});

test("strict target request and database adapter pass every immutable field to one gateway", async () => {
  const parsed = parseRestrictedCicdTargetRequest(request());
  assert.throws(() => parseRestrictedCicdTargetRequest({ ...request(), arbitrary: "value" }), /request invalid/);
  const verified = verifyRestrictedCicdGithubOidcToken({
    token: parsed.oidcToken, jwks, binding,
    providerRunId: parsed.providerRunId, jobId: parsed.jobId, environment: parsed.environment, now,
  });
  const calls = [];
  const database = createRestrictedCicdTargetDatabase({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ operation_id: parsed.operationId, owner_epoch: "1", replayed: false,
        execution_snapshot: executionSnapshot }] };
    },
  }, { now: () => now });
  const reservation = await database.reserve(parsed, verified, {
    identitySha256: sha("5"), evidenceSha256: sha("6"),
    targetBindingSha256: sha("2"), receiptTrustSha256: sha("3"),
  });
  assert.deepEqual({ operationId: reservation.operationId, ownerEpoch: reservation.ownerEpoch,
    replayed: reservation.replayed }, {
    operationId: "operation-target-1", ownerEpoch: 1, replayed: false,
  });
  assert.equal(reservation.identity.releaseVersionId, "release-target-1");
  assert.deepEqual(reservation.deployment.imageDigests, executionSnapshot.imageDigests);
  assert.match(calls[0].sql, /release_workflow_reserve_exact_target_request_v2/);
  assert.equal(calls[0].values.length, 20);
  assert.equal(calls[0].values[5], "778899");
  assert.equal(calls[0].values[8], sha("7"));
  assert.equal(calls[0].values[9], sha("8"));
  assert.equal(calls[0].values[10], binding.workflowSha256);
  assert.equal(calls[0].values[13], verified.jtiSha256);
});

test("workflow target request contains only dispatch inputs, exact run context, and OIDC", () => {
  const parsed = parseRestrictedCicdWorkflowTargetRequest({
    schemaVersion: "2",
    commandId: "command-staging-workflow",
    releaseVersionId: "release-next",
    providerRunId: "9001",
    jobId: "9002",
    environment: "staging",
    action: "deploy",
    artifactManifestSha256: sha("a"),
    environmentGeneration: 7,
    controlCommitSha: commit("b"),
    oidcToken: "header.payload.signature",
  });
  assert.equal(parsed.providerRunId, "9001");
  assert.throws(() => parseRestrictedCicdWorkflowTargetRequest({ ...parsed, authorizationId: "runner-controlled" }), /request invalid/i);
  assert.throws(() => parseRestrictedCicdWorkflowTargetRequest({ ...parsed, environmentGeneration: 0 }), /request invalid/i);
});

test("workflow target database adapter binds the activated Auditor trust digest", async () => {
  const parsed = parseRestrictedCicdWorkflowTargetRequest({
    schemaVersion: "2",
    commandId: executionSnapshot.commandId,
    releaseVersionId: executionSnapshot.releaseVersionId,
    providerRunId: "778899",
    jobId: "445566",
    environment: executionSnapshot.environment,
    action: executionSnapshot.action,
    artifactManifestSha256: executionSnapshot.artifactManifestSha256,
    environmentGeneration: executionSnapshot.environmentGeneration,
    controlCommitSha: executionSnapshot.controlCommitSha,
    oidcToken: token(),
  });
  const verified = verifyRestrictedCicdGithubOidcToken({
    token: parsed.oidcToken, jwks, binding,
    providerRunId: parsed.providerRunId, jobId: parsed.jobId,
    environment: parsed.environment, now,
  });
  const identityDigest = createHash("sha256").update([
    "restricted-cicd-workflow-target-v3", parsed.commandId, parsed.providerRunId,
    parsed.jobId, verified.jtiSha256,
  ].join("\x1f")).digest("hex");
  const calls = [];
  const database = createRestrictedCicdTargetDatabase({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{
        operation_id: `operation-v3-${identityDigest.slice(0, 48)}`,
        owner_epoch: "1",
        replayed: false,
        execution_snapshot: executionSnapshot,
      }] };
    },
  }, { now: () => now });
  await assert.rejects(database.reserveWorkflow(parsed, verified, {
    identitySha256: sha("5"), evidenceSha256: sha("6"),
    targetBindingSha256: binding.targetBindingSha256,
    receiptTrustSha256: binding.receiptTrustSha256,
    auditorTrustSha256: "invalid",
  }), (error) => error.code === "TARGET_REQUEST_OIDC_MISMATCH");
  const reservation = await database.reserveWorkflow(parsed, verified, {
    identitySha256: sha("5"), evidenceSha256: sha("6"),
    targetBindingSha256: binding.targetBindingSha256,
    receiptTrustSha256: binding.receiptTrustSha256,
    auditorTrustSha256: binding.auditorTrustSha256,
  });
  assert.equal(reservation.operationId, `operation-v3-${identityDigest.slice(0, 48)}`);
  assert.match(calls[0].sql, /release_workflow_reserve_workflow_target_request_v4/);
  assert.equal(calls[0].values.length, 15);
  assert.equal(calls[0].values[14], binding.auditorTrustSha256);
});

test("database adapter fences takeover and verifies a signed receipt before persistence", async () => {
  const { privateKey: receiptPrivateKey, publicKey: receiptPublicKey } = generateKeyPairSync("ed25519");
  const signed = signRestrictedCicdTargetReceipt({
    identity: {
      commandId: "command-target-1", releaseVersionId: "release-target-1", runId: "778899",
      runAttempt: 1, oidcJtiSha256: sha("3"), authorizationNonce: "authorization-nonce-1",
      operationId: "operation-target-1", environment: "staging", action: "deploy",
      workflowSha256: sha("4"), artifactManifestSha256: sha("5"), snapshotSha256: sha("6"),
      environmentGeneration: 1, expectedCurrentReleaseVersionId: null,
    },
    imageDigests: { client: sha("7"), operations: sha("8"),
      maintenance: sha("9"), runtime: sha("a") },
    migrationRegistrySha256: sha("b"), backupId: null, journalPhase: "cutover_committed",
    journalSequence: 1, ownerEpoch: 2, startedAt: new Date("2026-08-27T11:00:00.000Z"),
    completedAt: new Date("2026-08-27T11:00:01.000Z"), actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: "release-target-1", receiptNonce: "receipt-target-1",
    keyId: "receipt-key-1", privateKey: receiptPrivateKey,
  });
  const calls = [];
  const database = createRestrictedCicdTargetDatabase({
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("takeover")) return { rows: [{ owner_epoch: "2", replayed: false }] };
      if (sql.includes("validate_target_cutover")) {
        return { rows: [{ release_version_id: "release-target-1", validated_at: now }] };
      }
      if (sql.includes("assert_migration_registry")) {
        return { rows: [{ migration_registry_sha256: sha("b"), migration_count: "82" }] };
      }
      return { rows: [{ receipt_id: "receipt-target-1", replayed: false }] };
    },
  });
  assert.deepEqual(await database.takeover({
    takeoverId: "takeover-target-2", operationId: "operation-target-1",
    expectedOwnerEpoch: 1, newOwnerEpoch: 2, ownerIdentitySha256: sha("c"),
    evidenceSha256: sha("d"), reason: "The original target process is authoritatively stopped",
  }), { ownerEpoch: 2, replayed: false });
  assert.deepEqual(await database.validateCutover({
    operationId: "operation-target-1", ownerEpoch: 2, snapshotSha256: sha("6"),
    environmentGeneration: 1, expectedCurrentReleaseVersionId: null,
    releaseVersionId: "release-target-1",
    targetBindingSha256: sha("c"), receiptTrustSha256: sha("d"),
    backupId: "backup-operation-target-1", backupSha256: sha("e"), restoreTocSha256: sha("1"),
    restorePlanSha256: sha("f"), backupCreatedAt: now,
  }), { releaseVersionId: "release-target-1", validatedAt: now });
  assert.deepEqual(await database.assertMigrationRegistry(sha("b")), {
    migrationRegistrySha256: sha("b"), migrationCount: 82,
  });
  assert.deepEqual(await database.appendReceipt({
    receiptId: "receipt-target-1", signed, publicKey: receiptPublicKey,
  }), { receiptId: "receipt-target-1", replayed: false });
  assert.match(calls[0].sql, /takeover_target_operation/);
  assert.match(calls[1].sql, /validate_target_cutover_v2/);
  assert.match(calls[2].sql, /assert_migration_registry/);
  assert.match(calls[3].sql, /append_target_receipt/);
  assert.equal(calls[3].values[12], true);
  await assert.rejects(database.appendReceipt({
    receiptId: "receipt-target-2",
    signed: { ...signed, payload: { ...signed.payload, operationId: "operation-mutated" } },
    publicKey: receiptPublicKey,
  }), (error) => error.code === "TARGET_RECEIPT_INVALID");
});

test("stop adapter accepts only exact requests and verified target-signed receipts", async () => {
  const { privateKey: receiptPrivateKey, publicKey: receiptPublicKey } = generateKeyPairSync("ed25519");
  const stopRequest = parseRestrictedCicdTargetStopRequest({
    schemaVersion: "1", stopId: "stop-target-1", environment: "production",
    actorKind: "break_glass", actorIdentity: "offline-operator-1",
    reason: "Offline operator requested an emergency sticky stop",
  });
  assert.throws(() => parseRestrictedCicdTargetStopRequest({ ...stopRequest, extra: true }),
    (error) => error.code === "TARGET_STOP_REQUEST_INVALID");
  const requestedAt = new Date("2026-08-27T12:00:00.000Z");
  const calls = [];
  const database = createRestrictedCicdTargetDatabase({
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("target_request_stop")) return { rows: [{
        generation: "7", expected_current_release_version_id: "release-target-1",
        requested_at: requestedAt, replayed: false,
      }] };
      return { rows: [{ stop_receipt_id: "stop-target-1-receipt", replayed: false }] };
    },
  });
  const reserved = await database.requestStop(stopRequest);
  const signed = signRestrictedCicdStopReceipt({
    stopId: stopRequest.stopId, environment: stopRequest.environment, generation: reserved.generation,
    phase: "stop_committed",
    activationId: null, expectedCurrentReleaseVersionId: reserved.expectedCurrentReleaseVersionId,
    requestedAt: reserved.requestedAt, receiptNonce: "stop-target-1-committed", keyId: "receipt-key-1",
    actorKind: "break_glass", actorFingerprintSha256: sha("a"), privateKey: receiptPrivateKey,
  });
  assert.deepEqual(await database.appendStopReceipt({
    receiptId: "stop-target-1-receipt", signed, publicKey: receiptPublicKey,
    receiptTrustSha256: sha("b"),
  }), { receiptId: "stop-target-1-receipt", replayed: false });
  assert.match(calls[0].sql, /release_workflow_target_request_stop/);
  assert.match(calls[1].sql, /release_workflow_append_stop_receipt_v2/);
  await assert.rejects(database.appendStopReceipt({
    receiptId: "stop-target-1-receipt-2",
    signed: { ...signed, payload: { ...signed.payload, generation: 8 } },
    publicKey: receiptPublicKey, receiptTrustSha256: sha("b"),
  }), (error) => error.code === "TARGET_STOP_RECEIPT_INVALID");
});
