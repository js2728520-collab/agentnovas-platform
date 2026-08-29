export const RELEASE_WORKFLOW_ENVIRONMENTS = ["staging", "production"] as const;
export const RELEASE_WORKFLOW_ACTIONS = ["deploy", "rollback"] as const;

export type ReleaseWorkflowEnvironment = (typeof RELEASE_WORKFLOW_ENVIRONMENTS)[number];
export type ReleaseWorkflowAction = (typeof RELEASE_WORKFLOW_ACTIONS)[number];

export class RestrictedCicdDomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "RestrictedCicdDomainError";
    this.code = code;
    this.status = status;
  }
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: PlainObject, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isEnvironment(value: unknown): value is ReleaseWorkflowEnvironment {
  return typeof value === "string" && RELEASE_WORKFLOW_ENVIRONMENTS.includes(value as ReleaseWorkflowEnvironment);
}

function isAction(value: unknown): value is ReleaseWorkflowAction {
  return typeof value === "string" && RELEASE_WORKFLOW_ACTIONS.includes(value as ReleaseWorkflowAction);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedIdentifier(value: unknown, maximum = 160): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function isPositiveDecimalIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

function isProtectedTagRef(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("refs/tags/") || value.length > 209) return false;
  const tag = value.slice("refs/tags/".length);
  if (
    tag.length === 0
    || tag.endsWith("/")
    || tag.endsWith(".")
    || tag.includes("//")
    || tag.includes("..")
    || tag.includes("@{")
    || [...tag].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 32 || codePoint === 127;
    })
    || /[~^:?*[\\]/.test(tag)
  ) return false;
  return tag.split("/").every((component) => (
    component.length > 0
    && !component.startsWith(".")
    && !component.toLowerCase().endsWith(".lock")
  ));
}

function invalid(code: string, message: string): never {
  throw new RestrictedCicdDomainError(code, message);
}

export type ReleaseWorkflowCommandInput = {
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  reason: string;
};

export function parseReleaseWorkflowCommandInput(input: unknown): ReleaseWorkflowCommandInput {
  if (!isPlainObject(input) || !hasExactKeys(input, ["environment", "action", "reason"])) {
    return invalid("VALIDATION_ERROR", "请求体只能包含 environment、action 和 reason");
  }
  if (!isEnvironment(input.environment) || !isAction(input.action)) {
    return invalid("VALIDATION_ERROR", "environment 或 action 不在允许集合中");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    return invalid("VALIDATION_ERROR", "reason 必须为 3–500 个字符");
  }
  return { environment: input.environment, action: input.action, reason };
}

export type ReleaseWorkflowDispatchSnapshot = {
  workflowControlRef: string;
  commandId: string;
  releaseVersionId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  artifactManifestSha256: string;
  environmentGeneration: number;
};

export function buildReleaseWorkflowDispatchEnvelope(snapshot: ReleaseWorkflowDispatchSnapshot) {
  if (
    !isProtectedTagRef(snapshot.workflowControlRef)
    || !isBoundedIdentifier(snapshot.commandId)
    || !isBoundedIdentifier(snapshot.releaseVersionId)
    || !isEnvironment(snapshot.environment)
    || !isAction(snapshot.action)
    || !isSha256(snapshot.artifactManifestSha256)
    || !Number.isSafeInteger(snapshot.environmentGeneration)
    || snapshot.environmentGeneration < 1
  ) {
    return invalid("BINDING_INVALID", "dispatch snapshot 不满足固定 binding 合同");
  }
  return {
    ref: snapshot.workflowControlRef,
    inputs: {
      schema_version: "2",
      command_id: snapshot.commandId,
      release_version_id: snapshot.releaseVersionId,
      environment: snapshot.environment,
      action: snapshot.action,
      artifact_manifest_sha256: snapshot.artifactManifestSha256,
      environment_generation: String(snapshot.environmentGeneration),
    },
  } as const;
}

const IMAGE_DIGEST_KEYS = ["client", "operations", "maintenance", "runtime"] as const;
const EXECUTION_SNAPSHOT_KEYS = [
  "schemaVersion", "snapshotSha256", "commandId", "releaseVersionId", "environment", "action", "releaseTag",
  "releaseCommitSha", "imageDigests", "artifactManifestSha256", "migrationSetSha256", "migrationVersion",
  "hasIrreversibleMigrations", "controlCommitSha", "workflowId", "workflowPath", "workflowSha256",
  "environmentGeneration", "expectedCurrentReleaseVersionId", "stagingReceiptSha256", "rollbackEvidenceSha256",
  "rollbackEvidenceExpiresAt", "g7ActivationId", "g7ActivationSha256", "firstProductionEnablementId",
  "firstProductionEnablementSha256", "environmentPolicySha256", "runnerPolicySha256",
  "reviewerAllowlistSha256", "receiptTrustSha256", "auditorTrustSha256", "makerUserId", "checkerUserId", "reason",
  "createdAt", "approvedAt", "expiresAt",
] as const;

type ReleaseImageDigests = {
  client: string;
  operations: string;
  maintenance: string;
  runtime: string;
};

function validImageDigests(value: unknown): value is ReleaseImageDigests {
  return isPlainObject(value)
    && hasExactKeys(value, IMAGE_DIGEST_KEYS)
    && IMAGE_DIGEST_KEYS.every((key) => isSha256(value[key]));
}

function optionalBoundedIdentifier(value: unknown): value is string | null {
  return value === null || isBoundedIdentifier(value);
}

function optionalSha256(value: unknown): value is string | null {
  return value === null || isSha256(value);
}

function exactIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

export function validateReleaseWorkflowExecutionSnapshot(input: unknown, now: Date) {
  if (!isPlainObject(input) || !hasExactKeys(input, EXECUTION_SNAPSHOT_KEYS)) {
    return invalid("SNAPSHOT_INVALID", "execution snapshot 字段不完整或包含未知字段");
  }
  const createdAt = exactIsoTimestamp(input.createdAt);
  const approvedAt = exactIsoTimestamp(input.approvedAt);
  const expiresAt = exactIsoTimestamp(input.expiresAt);
  const rollbackExpiresAt = input.rollbackEvidenceExpiresAt === null
    ? null
    : exactIsoTimestamp(input.rollbackEvidenceExpiresAt);
  const baseValid = input.schemaVersion === "1"
    && isSha256(input.snapshotSha256)
    && isBoundedIdentifier(input.commandId)
    && isBoundedIdentifier(input.releaseVersionId)
    && isEnvironment(input.environment)
    && isAction(input.action)
    && typeof input.releaseTag === "string"
    && /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(input.releaseTag)
    && typeof input.releaseCommitSha === "string"
    && /^[a-f0-9]{40}$/.test(input.releaseCommitSha)
    && validImageDigests(input.imageDigests)
    && isSha256(input.artifactManifestSha256)
    && isSha256(input.migrationSetSha256)
    && typeof input.migrationVersion === "string"
    && /^[0-9]{4}_[a-z0-9_]{3,96}$/.test(input.migrationVersion)
    && typeof input.hasIrreversibleMigrations === "boolean"
    && typeof input.controlCommitSha === "string"
    && /^[a-f0-9]{40}$/.test(input.controlCommitSha)
    && isPositiveDecimalIdentifier(input.workflowId)
    && typeof input.workflowPath === "string"
    && /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ya?ml$/.test(input.workflowPath)
    && isSha256(input.workflowSha256)
    && Number.isSafeInteger(input.environmentGeneration)
    && Number(input.environmentGeneration) >= 1
    && optionalBoundedIdentifier(input.expectedCurrentReleaseVersionId)
    && optionalSha256(input.stagingReceiptSha256)
    && optionalSha256(input.rollbackEvidenceSha256)
    && (input.rollbackEvidenceExpiresAt === null || rollbackExpiresAt !== null)
    && isBoundedIdentifier(input.g7ActivationId)
    && isSha256(input.g7ActivationSha256)
    && optionalBoundedIdentifier(input.firstProductionEnablementId)
    && optionalSha256(input.firstProductionEnablementSha256)
    && isSha256(input.environmentPolicySha256)
    && isSha256(input.runnerPolicySha256)
    && isSha256(input.reviewerAllowlistSha256)
    && isSha256(input.receiptTrustSha256)
    && isSha256(input.auditorTrustSha256)
    && isBoundedIdentifier(input.makerUserId)
    && isBoundedIdentifier(input.checkerUserId)
    && input.makerUserId !== input.checkerUserId
    && typeof input.reason === "string"
    && input.reason.length >= 8
    && input.reason.length <= 500
    && createdAt !== null
    && approvedAt !== null
    && expiresAt !== null
    && createdAt < approvedAt
    && approvedAt < expiresAt;
  const pairedRollback = (input.rollbackEvidenceSha256 === null) === (input.rollbackEvidenceExpiresAt === null);
  const pairedProduction = (input.firstProductionEnablementId === null)
    === (input.firstProductionEnablementSha256 === null);
  const environmentPrerequisites = input.environment !== "production"
    || (input.stagingReceiptSha256 !== null
      && input.firstProductionEnablementId !== null
      && input.firstProductionEnablementSha256 !== null);
  const rollbackPrerequisites = input.action !== "rollback"
    || (input.rollbackEvidenceSha256 !== null
      && rollbackExpiresAt !== null
      && now < rollbackExpiresAt);
  if (!baseValid || !pairedRollback || !pairedProduction || !environmentPrerequisites || !rollbackPrerequisites) {
    return invalid("SNAPSHOT_INVALID", "execution snapshot binding 无效");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || approvedAt === null || expiresAt === null) {
    return invalid("SNAPSHOT_INVALID", "execution snapshot 时间无效");
  }
  if (now < approvedAt) {
    return invalid("SNAPSHOT_NOT_ACTIVE", "execution snapshot 尚未生效");
  }
  if (now >= expiresAt) {
    return invalid("SNAPSHOT_EXPIRED", "execution snapshot 已过期");
  }
  return input;
}

const POLICY_OBSERVATION_KEYS = [
  "kind",
  "repositoryId",
  "workflowId",
  "runId",
  "runAttempt",
  "jobId",
  "environmentId",
  "environment",
  "reviewerUserId",
  "reviewerType",
  "triggeringActorId",
  "reviewState",
  "hasRejectedReview",
  "reviewEvidenceSha256",
  "environmentPolicySha256",
  "runnerPolicySha256",
  "oidcJtiSha256",
  "nonce",
  "issuedAt",
  "expiresAt",
  "keyId",
  "signature",
] as const;

export type ExpectedProviderPolicyObservation = {
  repositoryId: string;
  workflowId: string;
  runId: string;
  runAttempt: 1;
  jobId: string;
  environmentId: string;
  environment: ReleaseWorkflowEnvironment;
  oidcJtiSha256: string;
  environmentPolicySha256: string;
  runnerPolicySha256: string;
  frozenReviewerUserIds: readonly string[];
  signatureVerified: boolean;
  now: Date;
};

function rejectedPolicyObservation(code: string) {
  return {
    accepted: false,
    semantics: "defense_in_depth_only",
    platformAuthorized: false,
    code,
  } as const;
}

export function assessProviderPolicyObservation(
  observation: unknown,
  expected: ExpectedProviderPolicyObservation,
) {
  if (!isPlainObject(observation) || !hasExactKeys(observation, POLICY_OBSERVATION_KEYS)) {
    return rejectedPolicyObservation("PROVIDER_POLICY_INVALID");
  }
  const issuedAt = typeof observation.issuedAt === "string" ? new Date(observation.issuedAt) : new Date(Number.NaN);
  const expiresAt = typeof observation.expiresAt === "string" ? new Date(observation.expiresAt) : new Date(Number.NaN);
  const timeIsValid = Number.isFinite(issuedAt.getTime())
    && Number.isFinite(expiresAt.getTime())
    && issuedAt < expiresAt
    && expected.now >= issuedAt
    && expected.now < expiresAt
    && expiresAt.getTime() - issuedAt.getTime() <= 300_000;
  const exactRunMatches = observation.repositoryId === expected.repositoryId
    && observation.workflowId === expected.workflowId
    && observation.runId === expected.runId
    && observation.runAttempt === expected.runAttempt
    && observation.jobId === expected.jobId
    && observation.environmentId === expected.environmentId
    && observation.environment === expected.environment
    && observation.oidcJtiSha256 === expected.oidcJtiSha256;
  const policyMatches = observation.environmentPolicySha256 === expected.environmentPolicySha256
    && observation.runnerPolicySha256 === expected.runnerPolicySha256;
  const reviewIsAcceptable = observation.reviewState === "approved"
    && observation.reviewerType === "User"
    && typeof observation.reviewerUserId === "string"
    && expected.frozenReviewerUserIds.includes(observation.reviewerUserId)
    && observation.reviewerUserId !== observation.triggeringActorId
    && observation.hasRejectedReview === false;
  const evidenceIsBounded = isPositiveDecimalIdentifier(observation.jobId)
    && isPositiveDecimalIdentifier(observation.repositoryId)
    && isPositiveDecimalIdentifier(observation.workflowId)
    && isPositiveDecimalIdentifier(observation.runId)
    && isPositiveDecimalIdentifier(observation.environmentId)
    && isPositiveDecimalIdentifier(observation.reviewerUserId)
    && isPositiveDecimalIdentifier(observation.triggeringActorId)
    && isSha256(observation.reviewEvidenceSha256)
    && isSha256(observation.environmentPolicySha256)
    && isSha256(observation.runnerPolicySha256)
    && isSha256(observation.oidcJtiSha256)
    && isBoundedIdentifier(observation.nonce)
    && isBoundedIdentifier(observation.keyId)
    && typeof observation.signature === "string"
    && observation.signature.length >= 8
    && observation.signature.length <= 512
    && /^[A-Za-z0-9+/]+={0,2}$/.test(observation.signature);
  if (
    observation.kind !== "provider_policy_observed"
    || !timeIsValid
    || !exactRunMatches
    || !policyMatches
    || !reviewIsAcceptable
    || !evidenceIsBounded
    || expected.signatureVerified !== true
  ) {
    return rejectedPolicyObservation("PROVIDER_POLICY_REJECTED");
  }
  return {
    accepted: true,
    semantics: "defense_in_depth_only",
    platformAuthorized: false,
    code: "PROVIDER_POLICY_OBSERVED",
  } as const;
}

export type TargetOperationIdentity = {
  commandId: string;
  releaseVersionId: string;
  runId: string;
  runAttempt: 1;
  oidcJtiSha256: string;
  authorizationNonce: string;
  operationId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  workflowSha256: string;
  artifactManifestSha256: string;
  snapshotSha256: string;
  environmentGeneration: number;
  expectedCurrentReleaseVersionId: string | null;
};

export type TargetOperationReservationRequest = {
  identity: TargetOperationIdentity;
  platformAuthorized: boolean;
  firstProductionEnablementValid: boolean;
  snapshotValid: boolean;
  generationMatches: boolean;
  currentMatches: boolean;
  stopCommitted: boolean;
  providerPolicyObserved: boolean;
};

const TARGET_OPERATION_IDENTITY_KEYS = [
  "commandId",
  "releaseVersionId",
  "runId",
  "runAttempt",
  "oidcJtiSha256",
  "authorizationNonce",
  "operationId",
  "environment",
  "action",
  "workflowSha256",
  "artifactManifestSha256",
  "snapshotSha256",
  "environmentGeneration",
  "expectedCurrentReleaseVersionId",
] as const;

const TARGET_OPERATION_RESERVATION_KEYS = [
  "identity",
  "platformAuthorized",
  "firstProductionEnablementValid",
  "snapshotValid",
  "generationMatches",
  "currentMatches",
  "stopCommitted",
  "providerPolicyObserved",
] as const;

function validTargetOperationIdentity(identity: unknown): identity is TargetOperationIdentity {
  return isPlainObject(identity)
    && hasExactKeys(identity, TARGET_OPERATION_IDENTITY_KEYS)
    && isBoundedIdentifier(identity.commandId)
    && isBoundedIdentifier(identity.releaseVersionId)
    && isPositiveDecimalIdentifier(identity.runId)
    && identity.runAttempt === 1
    && isSha256(identity.oidcJtiSha256)
    && isBoundedIdentifier(identity.authorizationNonce)
    && isBoundedIdentifier(identity.operationId)
    && isEnvironment(identity.environment)
    && isAction(identity.action)
    && isSha256(identity.workflowSha256)
    && isSha256(identity.artifactManifestSha256)
    && isSha256(identity.snapshotSha256)
    && typeof identity.environmentGeneration === "number"
    && Number.isSafeInteger(identity.environmentGeneration)
    && identity.environmentGeneration >= 1
    && optionalBoundedIdentifier(identity.expectedCurrentReleaseVersionId);
}

function validTargetOperationReservationRequest(requested: unknown): requested is TargetOperationReservationRequest {
  return isPlainObject(requested)
    && hasExactKeys(requested, TARGET_OPERATION_RESERVATION_KEYS)
    && validTargetOperationIdentity(requested.identity)
    && typeof requested.platformAuthorized === "boolean"
    && typeof requested.firstProductionEnablementValid === "boolean"
    && typeof requested.snapshotValid === "boolean"
    && typeof requested.generationMatches === "boolean"
    && typeof requested.currentMatches === "boolean"
    && typeof requested.stopCommitted === "boolean"
    && typeof requested.providerPolicyObserved === "boolean";
}

export function decideTargetOperationReservation(
  requested: unknown,
  existing: unknown,
) {
  if (!validTargetOperationReservationRequest(requested)) {
    return { decision: "reject", code: "OPERATION_IDENTITY_INVALID" } as const;
  }
  if (!requested.platformAuthorized) {
    return { decision: "reject", code: "PLATFORM_AUTHORIZATION_REQUIRED" } as const;
  }
  if (requested.identity.environment === "production" && !requested.firstProductionEnablementValid) {
    return { decision: "reject", code: "FIRST_PRODUCTION_ENABLEMENT_REQUIRED" } as const;
  }
  if (!requested.snapshotValid || !requested.generationMatches || !requested.currentMatches) {
    return { decision: "reject", code: "EXECUTION_SNAPSHOT_STALE" } as const;
  }
  if (requested.stopCommitted) return { decision: "reject", code: "EMERGENCY_STOPPED" } as const;
  if (!requested.providerPolicyObserved) {
    return { decision: "reject", code: "PROVIDER_POLICY_OBSERVATION_REQUIRED" } as const;
  }
  if (existing === null) return { decision: "reserve", operationId: requested.identity.operationId } as const;
  if (!validTargetOperationIdentity(existing)) {
    return { decision: "reject", code: "EXISTING_OPERATION_INVALID" } as const;
  }
  const matches = Object.keys(requested.identity).every((key) => (
    requested.identity[key as keyof TargetOperationIdentity] === existing[key as keyof TargetOperationIdentity]
  ));
  return matches
    ? { decision: "resume_existing", operationId: existing.operationId } as const
    : { decision: "reject", code: "OPERATION_IDENTITY_CONFLICT" } as const;
}

export type TargetStepGuard = {
  operationId: string;
  stepId: string;
  idempotencyKey: string;
  expectedOwnerEpoch: number;
  currentOwnerEpoch: number;
  checkpointDurable: boolean;
  adapterSupportsIdempotencyKey: boolean;
  hasAuthoritativeProbe: boolean;
};

const TARGET_STEP_GUARD_KEYS = [
  "operationId",
  "stepId",
  "idempotencyKey",
  "expectedOwnerEpoch",
  "currentOwnerEpoch",
  "checkpointDurable",
  "adapterSupportsIdempotencyKey",
  "hasAuthoritativeProbe",
] as const;

function validTargetStepGuard(guard: unknown): guard is TargetStepGuard {
  return isPlainObject(guard)
    && hasExactKeys(guard, TARGET_STEP_GUARD_KEYS)
    && isBoundedIdentifier(guard.operationId)
    && isBoundedIdentifier(guard.stepId)
    && isBoundedIdentifier(guard.idempotencyKey)
    && guard.idempotencyKey === `${guard.operationId}-${guard.stepId}`
    && typeof guard.checkpointDurable === "boolean"
    && typeof guard.adapterSupportsIdempotencyKey === "boolean"
    && typeof guard.hasAuthoritativeProbe === "boolean";
}

export function evaluateTargetStepGuard(guard: unknown) {
  if (!validTargetStepGuard(guard)) {
    return { decision: "reject", code: "STEP_GUARD_INVALID" } as const;
  }
  if (
    !Number.isSafeInteger(guard.expectedOwnerEpoch)
    || !Number.isSafeInteger(guard.currentOwnerEpoch)
    || guard.expectedOwnerEpoch < 1
    || guard.currentOwnerEpoch < 1
  ) {
    return { decision: "reject", code: "OWNER_EPOCH_INVALID" } as const;
  }
  if (guard.expectedOwnerEpoch !== guard.currentOwnerEpoch) {
    return { decision: "reject", code: "STALE_OWNER_EPOCH" } as const;
  }
  if (guard.checkpointDurable) return { decision: "skip_completed" } as const;
  if (guard.adapterSupportsIdempotencyKey) return { decision: "proceed" } as const;
  if (guard.hasAuthoritativeProbe) return { decision: "reconcile" } as const;
  return { decision: "uncertain", code: "STEP_OUTCOME_UNCERTAIN" } as const;
}

const TARGET_RECEIPT_EXTRA_KEYS = [
  "kind", "schemaVersion", "actualPreviousReleaseVersionId", "actualCurrentReleaseVersionId", "imageDigests",
  "migrationRegistrySha256", "backupId", "journalPhase", "journalSequence", "ownerEpoch", "startedAt",
  "completedAt", "result", "receiptNonce", "keyId", "signature",
] as const;

const TARGET_RECEIPT_PHASES = [
  "failed_before_cutover",
  "uncertain_before_cutover",
  "cutover_committed",
  "health_verified",
  "health_failed_after_cutover",
  "uncertain_after_cutover",
  "stop_committed",
] as const;

type TargetReceiptPhase = (typeof TARGET_RECEIPT_PHASES)[number];

function isTargetReceiptPhase(value: unknown): value is TargetReceiptPhase {
  return typeof value === "string" && TARGET_RECEIPT_PHASES.includes(value as TargetReceiptPhase);
}

function rejectedTargetReceipt(code: string) {
  return { accepted: false, code } as const;
}

export function assessTargetDeploymentReceipt(
  receipt: unknown,
  expected: {
    identity: TargetOperationIdentity;
    imageDigests: ReleaseImageDigests;
    migrationRegistrySha256: string;
    signatureVerified: boolean;
    keyValidAtCompletion: boolean;
    firstObservedBeforeCompromise: boolean;
    expectedOwnerEpoch: number;
    expectedJournalSequence: number;
  },
) {
  const receiptKeys = [...TARGET_OPERATION_IDENTITY_KEYS, ...TARGET_RECEIPT_EXTRA_KEYS];
  if (!isPlainObject(receipt) || !hasExactKeys(receipt, receiptKeys)) {
    return rejectedTargetReceipt("TARGET_RECEIPT_INVALID");
  }
  const identity = Object.fromEntries(
    TARGET_OPERATION_IDENTITY_KEYS.map((key) => [key, receipt[key]]),
  );
  const startedAt = exactIsoTimestamp(receipt.startedAt);
  const completedAt = exactIsoTimestamp(receipt.completedAt);
  const phaseValid = isTargetReceiptPhase(receipt.journalPhase)
    && receipt.result === receipt.journalPhase;
  const postCutover = [
    "cutover_committed",
    "health_verified",
    "health_failed_after_cutover",
    "uncertain_after_cutover",
  ].includes(String(receipt.journalPhase));
  const actualStateValid = receipt.actualPreviousReleaseVersionId === expected.identity.expectedCurrentReleaseVersionId
    && receipt.actualCurrentReleaseVersionId === (
      postCutover ? expected.identity.releaseVersionId : expected.identity.expectedCurrentReleaseVersionId
    );
  const receiptImages = receipt.imageDigests;
  const imagesMatch = validImageDigests(receiptImages)
    && IMAGE_DIGEST_KEYS.every((key) => receiptImages[key] === expected.imageDigests[key]);
  const valid = validTargetOperationIdentity(identity)
    && TARGET_OPERATION_IDENTITY_KEYS.every((key) => identity[key] === expected.identity[key])
    && receipt.kind === "target_deployment_receipt"
    && receipt.schemaVersion === "1"
    && optionalBoundedIdentifier(receipt.actualPreviousReleaseVersionId)
    && optionalBoundedIdentifier(receipt.actualCurrentReleaseVersionId)
    && imagesMatch
    && receipt.migrationRegistrySha256 === expected.migrationRegistrySha256
    && isSha256(receipt.migrationRegistrySha256)
    && optionalBoundedIdentifier(receipt.backupId)
    && phaseValid
    && Number.isSafeInteger(receipt.journalSequence)
    && Number(receipt.journalSequence) >= 1
    && receipt.journalSequence === expected.expectedJournalSequence
    && Number.isSafeInteger(receipt.ownerEpoch)
    && Number(receipt.ownerEpoch) >= 1
    && receipt.ownerEpoch === expected.expectedOwnerEpoch
    && startedAt !== null
    && completedAt !== null
    && startedAt <= completedAt
    && actualStateValid
    && isBoundedIdentifier(receipt.receiptNonce)
    && isBoundedIdentifier(receipt.keyId)
    && typeof receipt.signature === "string"
    && receipt.signature.length >= 8
    && receipt.signature.length <= 512
    && /^[A-Za-z0-9+/]+={0,2}$/.test(receipt.signature)
    && expected.signatureVerified === true
    && expected.keyValidAtCompletion === true
    && expected.firstObservedBeforeCompromise === true;
  if (!valid) return rejectedTargetReceipt("TARGET_RECEIPT_REJECTED");
  return {
    accepted: true,
    code: "TARGET_RECEIPT_ACCEPTED",
    targetPhase: receipt.journalPhase as TargetReceiptPhase,
  } as const;
}

export type ProviderConclusion = "pending" | "success" | "failure" | "cancelled" | "unknown";
export type TargetOperationPhase =
  | "not_started"
  | "prepared"
  | "applying"
  | "cutover_intent_durable"
  | "cancelled_before_cutover"
  | "stop_committed"
  | "failed_before_cutover"
  | "uncertain_before_cutover"
  | "cutover_committed"
  | "health_verified"
  | "health_failed_after_cutover"
  | "uncertain_after_cutover";

export function projectReleaseWorkflowOutcome(input: {
  providerConclusion: ProviderConclusion;
  targetPhase: TargetOperationPhase;
  stopCommitted: boolean;
}) {
  const physicalCurrentChanged = [
    "cutover_committed",
    "health_verified",
    "health_failed_after_cutover",
    "uncertain_after_cutover",
  ].includes(input.targetPhase);
  if (physicalCurrentChanged) {
    if (input.targetPhase === "uncertain_after_cutover") {
      return { commandStatus: "manual_intervention", shouldRecordDeployment: true, shouldUpdateCurrent: true } as const;
    }
    if (input.targetPhase === "health_verified" && input.providerConclusion === "success" && !input.stopCommitted) {
      return { commandStatus: "succeeded", shouldRecordDeployment: true, shouldUpdateCurrent: true } as const;
    }
    const stillSettling = !input.stopCommitted
      && (input.providerConclusion === "pending" || input.providerConclusion === "success")
      && input.targetPhase !== "health_failed_after_cutover";
    return {
      commandStatus: stillSettling ? "settling" : "deployed_reconciliation_required",
      shouldRecordDeployment: true,
      shouldUpdateCurrent: true,
    } as const;
  }
  if (input.targetPhase === "failed_before_cutover") {
    return { commandStatus: "failed", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (input.targetPhase === "cancelled_before_cutover" || input.targetPhase === "stop_committed") {
    return { commandStatus: "cancelled", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (input.targetPhase === "uncertain_before_cutover") {
    return { commandStatus: "manual_intervention", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (["prepared", "applying", "cutover_intent_durable"].includes(input.targetPhase)) {
    return {
      commandStatus: input.providerConclusion === "pending" ? "running" : "settling",
      shouldRecordDeployment: false,
      shouldUpdateCurrent: false,
    } as const;
  }
  if (input.providerConclusion === "unknown") {
    return { commandStatus: "manual_intervention", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (input.providerConclusion === "success") {
    return { commandStatus: "settling", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (input.stopCommitted || input.providerConclusion === "cancelled") {
    return { commandStatus: "cancelled", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  if (input.providerConclusion === "failure") {
    return { commandStatus: "failed", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
  }
  return { commandStatus: "running", shouldRecordDeployment: false, shouldUpdateCurrent: false } as const;
}
