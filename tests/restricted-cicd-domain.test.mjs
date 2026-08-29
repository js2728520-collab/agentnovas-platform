import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProviderPolicyObservation,
  assessTargetDeploymentReceipt,
  buildReleaseWorkflowDispatchEnvelope,
  decideTargetOperationReservation,
  evaluateTargetStepGuard,
  parseReleaseWorkflowCommandInput,
  projectReleaseWorkflowOutcome,
  validateReleaseWorkflowExecutionSnapshot,
} from "../lib/restricted-cicd-domain.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const executionSnapshot = {
  schemaVersion: "1",
  snapshotSha256: SHA_C,
  commandId: "cmd-1",
  releaseVersionId: "rel-1",
  environment: "production",
  action: "deploy",
  releaseTag: "v1.2.3",
  releaseCommitSha: "d".repeat(40),
  imageDigests: { client: SHA_A, operations: SHA_A, maintenance: SHA_B, runtime: SHA_B },
  artifactManifestSha256: SHA_A,
  migrationSetSha256: SHA_B,
  migrationVersion: "0077_release_workflow_facts",
  hasIrreversibleMigrations: false,
  controlCommitSha: "e".repeat(40),
  workflowId: "67890",
  workflowPath: ".github/workflows/restricted-release.yml",
  workflowSha256: SHA_C,
  environmentGeneration: 7,
  expectedCurrentReleaseVersionId: "rel-previous",
  stagingReceiptSha256: SHA_A,
  rollbackEvidenceSha256: null,
  rollbackEvidenceExpiresAt: null,
  g7ActivationId: "activation-1",
  g7ActivationSha256: SHA_B,
  firstProductionEnablementId: "prod-enable-1",
  firstProductionEnablementSha256: SHA_C,
  environmentPolicySha256: SHA_A,
  runnerPolicySha256: SHA_B,
  reviewerAllowlistSha256: SHA_C,
  receiptTrustSha256: SHA_A,
  auditorTrustSha256: SHA_B,
  makerUserId: "user-maker",
  checkerUserId: "user-checker",
  reason: "approved immutable release",
  createdAt: "2026-08-27T10:00:00.000Z",
  approvedAt: "2026-08-27T10:01:00.000Z",
  expiresAt: "2026-08-27T10:16:00.000Z",
};

test("execution snapshot freezes every approval binding and fails closed on drift or expiry", () => {
  assert.deepEqual(
    validateReleaseWorkflowExecutionSnapshot(executionSnapshot, new Date("2026-08-27T10:05:00.000Z")),
    executionSnapshot,
  );
  for (const invalidSnapshot of [
    { ...executionSnapshot, checkerUserId: "user-maker" },
    { ...executionSnapshot, stagingReceiptSha256: null },
    { ...executionSnapshot, firstProductionEnablementId: null, firstProductionEnablementSha256: null },
    { ...executionSnapshot, workflowPath: "../../deploy.yml" },
    { ...executionSnapshot, extra: "not allowed" },
  ]) {
    assert.throws(
      () => validateReleaseWorkflowExecutionSnapshot(invalidSnapshot, new Date("2026-08-27T10:05:00.000Z")),
      (error) => error?.code === "SNAPSHOT_INVALID",
    );
  }
  assert.throws(
    () => validateReleaseWorkflowExecutionSnapshot(executionSnapshot, new Date("2026-08-27T10:16:00.000Z")),
    (error) => error?.code === "SNAPSHOT_EXPIRED",
  );
  assert.throws(
    () => validateReleaseWorkflowExecutionSnapshot(executionSnapshot, new Date("2026-08-27T10:00:30.000Z")),
    (error) => error?.code === "SNAPSHOT_NOT_ACTIVE",
  );
});

test("restricted CI/CD public command accepts only action, environment, and a bounded reason", () => {
  assert.deepEqual(parseReleaseWorkflowCommandInput({
    environment: "production",
    action: "deploy",
    reason: "  发布已审批的不可变制品  ",
  }), {
    environment: "production",
    action: "deploy",
    reason: "发布已审批的不可变制品",
  });

  for (const body of [
    null,
    { environment: "production", action: "deploy", reason: "短" },
    { environment: "preview", action: "deploy", reason: "不允许的环境" },
    { environment: "production", action: "shell", reason: "不允许的动作" },
    { environment: "production", action: "deploy", reason: "注入 ref", ref: "main" },
    { environment: "production", action: "deploy", reason: "注入命令", command: "docker ps" },
    { environment: "production", action: "deploy", reason: "r".repeat(501) },
  ]) {
    assert.throws(
      () => parseReleaseWorkflowCommandInput(body),
      (error) => error?.code === "VALIDATION_ERROR" && error?.status === 422,
      JSON.stringify(body),
    );
  }
});

test("dispatch envelope contains only server-owned ref and the frozen schema-v2 inputs", () => {
  assert.deepEqual(buildReleaseWorkflowDispatchEnvelope({
    workflowControlRef: "refs/tags/agentnovas-deploy-v1",
    commandId: "cmd-01J6M4Q3F3T7RZ8E3R4W9Y5K2A",
    releaseVersionId: "rel-01J6M4Q8Y3BTG35AMCPY51W30V",
    environment: "staging",
    action: "rollback",
    artifactManifestSha256: SHA_A,
    environmentGeneration: 42,
  }), {
    ref: "refs/tags/agentnovas-deploy-v1",
    inputs: {
      schema_version: "2",
      command_id: "cmd-01J6M4Q3F3T7RZ8E3R4W9Y5K2A",
      release_version_id: "rel-01J6M4Q8Y3BTG35AMCPY51W30V",
      environment: "staging",
      action: "rollback",
      artifact_manifest_sha256: SHA_A,
      environment_generation: "42",
    },
  });

  assert.throws(
    () => buildReleaseWorkflowDispatchEnvelope({
      workflowControlRef: "main",
      commandId: "cmd-1",
      releaseVersionId: "rel-1",
      environment: "staging",
      action: "deploy",
      artifactManifestSha256: "latest",
      environmentGeneration: 0,
    }),
    (error) => error?.code === "BINDING_INVALID",
  );

  for (const workflowControlRef of [
    "refs/tags/.hidden",
    "refs/tags/release.lock",
    "refs/tags/release/",
    "refs/tags/release//v1",
    "refs/tags/release@{v1",
    "refs/tags/release v1",
    "refs/tags/release~v1",
  ]) {
    assert.throws(
      () => buildReleaseWorkflowDispatchEnvelope({
        workflowControlRef,
        commandId: "cmd-1",
        releaseVersionId: "rel-1",
        environment: "staging",
        action: "deploy",
        artifactManifestSha256: SHA_A,
        environmentGeneration: 1,
      }),
      (error) => error?.code === "BINDING_INVALID",
      workflowControlRef,
    );
  }
});

test("provider policy observation is defense-in-depth and never becomes platform authorization", () => {
  const result = assessProviderPolicyObservation({
    kind: "provider_policy_observed",
    repositoryId: "12345",
    workflowId: "67890",
    runId: "111222333",
    runAttempt: 1,
    jobId: "444555666",
    environmentId: "777888999",
    environment: "production",
    reviewerUserId: "24680",
    reviewerType: "User",
    triggeringActorId: "13579",
    reviewState: "approved",
    hasRejectedReview: false,
    reviewEvidenceSha256: SHA_A,
    environmentPolicySha256: SHA_A,
    runnerPolicySha256: SHA_B,
    oidcJtiSha256: SHA_B,
    nonce: "policy-01J6M4QK6B7VDHXQG2CFEK8S9N",
    issuedAt: "2026-08-27T10:00:00.000Z",
    expiresAt: "2026-08-27T10:01:00.000Z",
    keyId: "auditor-ed25519-2026-08",
    signature: "c2lnbmF0dXJl",
  }, {
    repositoryId: "12345",
    workflowId: "67890",
    runId: "111222333",
    runAttempt: 1,
    jobId: "444555666",
    environmentId: "777888999",
    environment: "production",
    oidcJtiSha256: SHA_B,
    environmentPolicySha256: SHA_A,
    runnerPolicySha256: SHA_B,
    frozenReviewerUserIds: ["24680"],
    signatureVerified: true,
    now: new Date("2026-08-27T10:00:30.000Z"),
  });

  assert.deepEqual(result, {
    accepted: true,
    semantics: "defense_in_depth_only",
    platformAuthorized: false,
    code: "PROVIDER_POLICY_OBSERVED",
  });
});

test("provider policy observation rejects rejected, self-reviewed, replay-prone, expired, or mismatched evidence", () => {
  const base = {
    kind: "provider_policy_observed",
    repositoryId: "12345",
    workflowId: "67890",
    runId: "111222333",
    runAttempt: 1,
    jobId: "444555666",
    environmentId: "777888999",
    environment: "production",
    reviewerUserId: "24680",
    reviewerType: "User",
    triggeringActorId: "13579",
    reviewState: "approved",
    hasRejectedReview: false,
    reviewEvidenceSha256: SHA_A,
    environmentPolicySha256: SHA_A,
    runnerPolicySha256: SHA_B,
    oidcJtiSha256: SHA_B,
    nonce: "policy-01J6M4QK6B7VDHXQG2CFEK8S9N",
    issuedAt: "2026-08-27T10:00:00.000Z",
    expiresAt: "2026-08-27T10:01:00.000Z",
    keyId: "auditor-ed25519-2026-08",
    signature: "c2lnbmF0dXJl",
  };
  const expected = {
    repositoryId: "12345",
    workflowId: "67890",
    runId: "111222333",
    runAttempt: 1,
    jobId: "444555666",
    environmentId: "777888999",
    environment: "production",
    oidcJtiSha256: SHA_B,
    environmentPolicySha256: SHA_A,
    runnerPolicySha256: SHA_B,
    frozenReviewerUserIds: ["24680"],
    signatureVerified: true,
    now: new Date("2026-08-27T10:00:30.000Z"),
  };

  for (const observation of [
    { ...base, hasRejectedReview: true },
    { ...base, triggeringActorId: "24680" },
    { ...base, reviewerUserId: "99999" },
    { ...base, runAttempt: 2 },
    { ...base, jobId: "444555667" },
    { ...base, environmentPolicySha256: SHA_B },
    { ...base, expiresAt: "2026-08-27T10:00:20.000Z" },
    { ...base, extra: "not allowed" },
  ]) {
    assert.equal(assessProviderPolicyObservation(observation, expected).accepted, false);
  }
  assert.equal(assessProviderPolicyObservation(base, { ...expected, signatureVerified: false }).accepted, false);
  assert.equal(assessProviderPolicyObservation(
    { ...base, repositoryId: "not-numeric" },
    { ...expected, repositoryId: "not-numeric" },
  ).accepted, false);
});

test("target reservation requires platform authorization and is a single exact operation", () => {
  const identity = {
    commandId: "cmd-1",
    releaseVersionId: "rel-1",
    runId: "111222333",
    runAttempt: 1,
    oidcJtiSha256: SHA_A,
    authorizationNonce: "auth-1",
    operationId: "op-1",
    environment: "production",
    action: "deploy",
    workflowSha256: SHA_C,
    artifactManifestSha256: SHA_A,
    snapshotSha256: SHA_B,
    environmentGeneration: 7,
    expectedCurrentReleaseVersionId: "rel-previous",
  };
  const request = {
    identity,
    platformAuthorized: true,
    firstProductionEnablementValid: true,
    snapshotValid: true,
    generationMatches: true,
    currentMatches: true,
    stopCommitted: false,
    providerPolicyObserved: true,
  };
  assert.deepEqual(decideTargetOperationReservation(request, null), {
    decision: "reserve",
    operationId: "op-1",
  });
  assert.deepEqual(decideTargetOperationReservation(request, identity), {
    decision: "resume_existing",
    operationId: "op-1",
  });
  assert.deepEqual(decideTargetOperationReservation({
    ...request,
    identity: { ...identity, operationId: "op-2" },
  }, identity), {
    decision: "reject",
    code: "OPERATION_IDENTITY_CONFLICT",
  });

  for (const unsafeRequest of [
    { ...request, platformAuthorized: false },
    { ...request, firstProductionEnablementValid: false },
    { ...request, snapshotValid: false },
    { ...request, generationMatches: false },
    { ...request, currentMatches: false },
    { ...request, stopCommitted: true },
    { ...request, providerPolicyObserved: false },
    { ...request, identity: { ...identity, runAttempt: 2 } },
    { ...request, identity: { ...identity, extra: "not allowed" } },
  ]) {
    assert.equal(decideTargetOperationReservation(unsafeRequest, null).decision, "reject");
  }
  assert.equal(decideTargetOperationReservation(null, null).decision, "reject");
  assert.deepEqual(decideTargetOperationReservation(request, { ...identity, environment: "staging" }), {
    decision: "reject",
    code: "OPERATION_IDENTITY_CONFLICT",
  });
});

test("target step guard rejects stale owners and requires idempotency or an authoritative probe", () => {
  assert.deepEqual(evaluateTargetStepGuard({
    operationId: "op-1",
    stepId: "pull-images",
    idempotencyKey: "op-1-pull-images",
    expectedOwnerEpoch: 8,
    currentOwnerEpoch: 9,
    checkpointDurable: true,
    adapterSupportsIdempotencyKey: true,
    hasAuthoritativeProbe: false,
  }), { decision: "reject", code: "STALE_OWNER_EPOCH" });

  assert.deepEqual(evaluateTargetStepGuard({
    operationId: "op-1",
    stepId: "pull-images",
    idempotencyKey: "op-1-pull-images",
    expectedOwnerEpoch: 9,
    currentOwnerEpoch: 9,
    checkpointDurable: false,
    adapterSupportsIdempotencyKey: false,
    hasAuthoritativeProbe: false,
  }), { decision: "uncertain", code: "STEP_OUTCOME_UNCERTAIN" });

  assert.deepEqual(evaluateTargetStepGuard({
    operationId: "op-1",
    stepId: "pull-images",
    idempotencyKey: "op-1-pull-images",
    expectedOwnerEpoch: 9,
    currentOwnerEpoch: 9,
    checkpointDurable: false,
    adapterSupportsIdempotencyKey: false,
    hasAuthoritativeProbe: true,
  }), { decision: "reconcile" });

  assert.deepEqual(evaluateTargetStepGuard({
    operationId: "op-1",
    stepId: "pull-images",
    idempotencyKey: "op-1-pull-images",
    expectedOwnerEpoch: 9,
    currentOwnerEpoch: 9,
    checkpointDurable: true,
    adapterSupportsIdempotencyKey: false,
    hasAuthoritativeProbe: false,
  }), { decision: "skip_completed" });

  for (const invalidGuard of [
    null,
    {
      operationId: "op-1",
      stepId: "pull-images",
      idempotencyKey: "op-1-pull-images",
      expectedOwnerEpoch: 9,
      currentOwnerEpoch: 9,
      checkpointDurable: "true",
      adapterSupportsIdempotencyKey: false,
      hasAuthoritativeProbe: false,
    },
    {
      operationId: "op-1",
      stepId: "pull-images",
      idempotencyKey: "wrong-key",
      expectedOwnerEpoch: 9,
      currentOwnerEpoch: 9,
      checkpointDurable: true,
      adapterSupportsIdempotencyKey: false,
      hasAuthoritativeProbe: false,
      arbitraryCommand: "docker ps",
    },
  ]) {
    assert.deepEqual(evaluateTargetStepGuard(invalidGuard), {
      decision: "reject",
      code: "STEP_GUARD_INVALID",
    });
  }
});

test("target receipt is strict, exact-operation bound, and cannot self-assert signature validity", () => {
  const identity = {
    commandId: "cmd-1",
    releaseVersionId: "rel-1",
    runId: "111222333",
    runAttempt: 1,
    oidcJtiSha256: SHA_A,
    authorizationNonce: "auth-1",
    operationId: "op-1",
    environment: "production",
    action: "deploy",
    workflowSha256: SHA_C,
    artifactManifestSha256: SHA_A,
    snapshotSha256: SHA_B,
    environmentGeneration: 7,
    expectedCurrentReleaseVersionId: "rel-previous",
  };
  const receipt = {
    kind: "target_deployment_receipt",
    schemaVersion: "1",
    ...identity,
    actualPreviousReleaseVersionId: "rel-previous",
    actualCurrentReleaseVersionId: "rel-1",
    imageDigests: executionSnapshot.imageDigests,
    migrationRegistrySha256: SHA_C,
    backupId: "backup-1",
    journalPhase: "health_failed_after_cutover",
    journalSequence: 9,
    ownerEpoch: 3,
    startedAt: "2026-08-27T10:05:00.000Z",
    completedAt: "2026-08-27T10:06:00.000Z",
    result: "health_failed_after_cutover",
    receiptNonce: "receipt-1",
    keyId: "receipt-key-1",
    signature: "c2lnbmF0dXJl",
  };
  const expected = {
    identity,
    imageDigests: executionSnapshot.imageDigests,
    migrationRegistrySha256: SHA_C,
    signatureVerified: true,
    keyValidAtCompletion: true,
    firstObservedBeforeCompromise: true,
    expectedOwnerEpoch: 3,
    expectedJournalSequence: 9,
  };
  assert.deepEqual(assessTargetDeploymentReceipt(receipt, expected), {
    accepted: true,
    code: "TARGET_RECEIPT_ACCEPTED",
    targetPhase: "health_failed_after_cutover",
  });
  for (const candidate of [
    { receipt: { ...receipt, environment: "staging" }, expected },
    { receipt: { ...receipt, actualCurrentReleaseVersionId: "rel-other" }, expected },
    { receipt: { ...receipt, extra: "not allowed" }, expected },
    { receipt, expected: { ...expected, signatureVerified: false } },
    { receipt, expected: { ...expected, firstObservedBeforeCompromise: false } },
    { receipt: { ...receipt, ownerEpoch: 2 }, expected },
    { receipt: { ...receipt, journalSequence: 8 }, expected },
  ]) {
    assert.equal(assessTargetDeploymentReceipt(candidate.receipt, candidate.expected).accepted, false);
  }
});

test("cutover receipt controls physical current even when health or provider settlement fails", () => {
  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "failure",
    targetPhase: "cutover_committed",
    stopCommitted: true,
  }), {
    commandStatus: "deployed_reconciliation_required",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "failure",
    targetPhase: "applying",
    stopCommitted: true,
  }), {
    commandStatus: "settling",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "cancelled",
    targetPhase: "prepared",
    stopCommitted: true,
  }), {
    commandStatus: "settling",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "pending",
    targetPhase: "health_verified",
    stopCommitted: false,
  }), {
    commandStatus: "settling",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "success",
    targetPhase: "cutover_committed",
    stopCommitted: false,
  }), {
    commandStatus: "settling",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "success",
    targetPhase: "not_started",
    stopCommitted: false,
  }), {
    commandStatus: "settling",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "success",
    targetPhase: "health_verified",
    stopCommitted: false,
  }), {
    commandStatus: "succeeded",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "unknown",
    targetPhase: "uncertain_after_cutover",
    stopCommitted: false,
  }), {
    commandStatus: "manual_intervention",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "success",
    targetPhase: "failed_before_cutover",
    stopCommitted: false,
  }), {
    commandStatus: "failed",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "unknown",
    targetPhase: "failed_before_cutover",
    stopCommitted: false,
  }), {
    commandStatus: "failed",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "cancelled",
    targetPhase: "uncertain_before_cutover",
    stopCommitted: true,
  }), {
    commandStatus: "manual_intervention",
    shouldRecordDeployment: false,
    shouldUpdateCurrent: false,
  });

  assert.deepEqual(projectReleaseWorkflowOutcome({
    providerConclusion: "success",
    targetPhase: "health_failed_after_cutover",
    stopCommitted: false,
  }), {
    commandStatus: "deployed_reconciliation_required",
    shouldRecordDeployment: true,
    shouldUpdateCurrent: true,
  });
});

test("restricted CI/CD domain module remains pure and cannot dispatch or access secrets", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("../lib/restricted-cicd-domain.ts", import.meta.url), "utf8")
  ));
  assert.doesNotMatch(source, /fetch\s*\(|node:https|@octokit|process\.env|\bpg\b|child_process|\bssh\b|\bdocker\b|\bkubectl\b/i);
});
