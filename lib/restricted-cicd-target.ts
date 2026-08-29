import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

import type { RestrictedCicdGithubBinding } from "./restricted-cicd-github.ts";
import {
  validateReleaseWorkflowExecutionSnapshot,
  type ReleaseWorkflowAction,
  type ReleaseWorkflowEnvironment,
} from "./restricted-cicd-domain.ts";
import {
  canonicalizeRestrictedCicdReceipt,
  verifyRestrictedCicdTargetReceiptSignature,
  type SignedRestrictedCicdTargetReceipt,
} from "./restricted-cicd-target-journal.ts";

type JsonObject = Record<string, unknown>;
type QueryResult = { rows: Array<Record<string, unknown>> };
type Queryable = { query: (text: string, values?: unknown[]) => Promise<QueryResult> };

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const MAX_TOKEN_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;

export type RestrictedCicdTargetRequest = {
  schemaVersion: "1";
  authorizationId: string;
  operationId: string;
  commandId: string;
  attemptKey: string;
  attestationId: string;
  authorizationNonce: string;
  expiresAt: string;
  providerRunId: string;
  jobId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  snapshotSha256: string;
  artifactManifestSha256: string;
  workflowSha256: string;
  environmentGeneration: number;
  expectedCurrentReleaseVersionId: string | null;
  oidcToken: string;
};

export type RestrictedCicdWorkflowTargetRequest = {
  schemaVersion: "2";
  commandId: string;
  releaseVersionId: string;
  providerRunId: string;
  jobId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  artifactManifestSha256: string;
  environmentGeneration: number;
  controlCommitSha: string;
  oidcToken: string;
};

export type RestrictedCicdTargetStopRequest = {
  schemaVersion: "1";
  stopId: string;
  environment: ReleaseWorkflowEnvironment;
  actorKind: "user" | "break_glass";
  actorIdentity: string;
  reason: string;
};

export type RestrictedCicdTargetClearRequest = {
  schemaVersion: "1";
  stopId: string;
  environment: ReleaseWorkflowEnvironment;
  generation: number;
  activationId: string;
  expectedCurrentReleaseVersionId: string | null;
  actorIdentity: string;
  reason: string;
};

export type VerifiedRestrictedCicdOidc = {
  providerRunId: string;
  jobId: string;
  environment: ReleaseWorkflowEnvironment;
  jtiSha256: string;
  issuedAt: Date;
  expiresAt: Date;
  claimsSha256: string;
};

export class RestrictedCicdTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdTargetError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdTargetError(code, message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: JsonObject, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function exactIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function base64urlJson(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > MAX_TOKEN_BYTES) {
    return fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  }
  try {
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment) throw new Error("noncanonical");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    return isObject(parsed) ? parsed : fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  } catch {
    return fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  }
}

function numericDate(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactAudience(value: unknown, expected: string) {
  return value === expected;
}

function expectedSubjects(binding: RestrictedCicdGithubBinding, environment: ReleaseWorkflowEnvironment) {
  const legacy = `repo:${binding.repositoryOwner}/${binding.repositoryName}:environment:${environment}`;
  const immutable = `repo:${binding.repositoryOwner}@${binding.accountId}/${binding.repositoryName}@${binding.repositoryId}:environment:${environment}`;
  return new Set([legacy, immutable]);
}

function publicJwkForKid(jwks: unknown, kid: string) {
  if (!isObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 20) {
    return fail("OIDC_JWKS_INVALID", "GitHub OIDC key set invalid");
  }
  const matches = jwks.keys.filter((candidate) => isObject(candidate) && candidate.kid === kid);
  if (matches.length !== 1) return fail("OIDC_JWKS_INVALID", "GitHub OIDC key set invalid");
  const key = matches[0];
  if (key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig"
    || typeof key.n !== "string" || !/^[A-Za-z0-9_-]{200,800}$/.test(key.n)
    || key.e !== "AQAB") {
    return fail("OIDC_JWKS_INVALID", "GitHub OIDC key set invalid");
  }
  try {
    return createPublicKey({ key: key as JsonWebKey, format: "jwk" });
  } catch {
    return fail("OIDC_JWKS_INVALID", "GitHub OIDC key set invalid");
  }
}

export async function fetchRestrictedCicdGithubOidcJwks(
  dependencies: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 5_000);
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(GITHUB_OIDC_JWKS_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok || response.url !== GITHUB_OIDC_JWKS_URL) throw new Error("jwks response");
    const body = await response.text();
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error("jwks size");
    return JSON.parse(body) as unknown;
  } catch {
    return fail("OIDC_JWKS_UNAVAILABLE", "GitHub OIDC key set unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyRestrictedCicdGithubOidcToken(input: {
  token: string;
  jwks: unknown;
  binding: RestrictedCicdGithubBinding;
  providerRunId: string;
  jobId: string;
  environment: ReleaseWorkflowEnvironment;
  now?: Date;
}): VerifiedRestrictedCicdOidc {
  if (typeof input.token !== "string" || Buffer.byteLength(input.token) > MAX_TOKEN_BYTES
    || !DECIMAL_ID.test(input.providerRunId) || !DECIMAL_ID.test(input.jobId)
    || (input.environment !== "staging" && input.environment !== "production")) {
    return fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  }
  const segments = input.token.split(".");
  if (segments.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(segments[2])) {
    return fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  }
  const header = base64urlJson(segments[0]);
  const claims = base64urlJson(segments[1]);
  if (!exactKeys(header, ["alg", "kid", "typ"]) || header.alg !== "RS256" || header.typ !== "JWT"
    || typeof header.kid !== "string" || !/^[A-Za-z0-9._-]{3,200}$/.test(header.kid)) {
    return fail("OIDC_TOKEN_INVALID", "GitHub OIDC token invalid");
  }
  const signature = Buffer.from(segments[2], "base64url");
  if (signature.toString("base64url") !== segments[2] || signature.byteLength < 128 || signature.byteLength > 1024
    || !verify("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`), publicJwkForKid(input.jwks, header.kid), signature)) {
    return fail("OIDC_SIGNATURE_INVALID", "GitHub OIDC signature invalid");
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const iat = numericDate(claims.iat);
  const nbf = numericDate(claims.nbf);
  const exp = numericDate(claims.exp);
  const expectedWorkflowRef = `${input.binding.repositoryOwner}/${input.binding.repositoryName}/${input.binding.workflowPath}@${input.binding.workflowControlRef}`;
  const expectedRepository = `${input.binding.repositoryOwner}/${input.binding.repositoryName}`;
  const jti = claims.jti;
  if (!Number.isFinite(nowMs) || iat === null || nbf === null || exp === null
    || exp <= iat || exp - iat > 600 || nbf < iat - 30
    || nowMs < (nbf - 30) * 1_000 || nowMs >= (exp + 30) * 1_000 || iat * 1_000 > nowMs + 30_000
    || claims.iss !== GITHUB_OIDC_ISSUER
    || !exactAudience(claims.aud, input.binding.oidcAudience)
    || typeof claims.sub !== "string" || !expectedSubjects(input.binding, input.environment).has(claims.sub)
    || claims.repository !== expectedRepository
    || claims.repository_id !== input.binding.repositoryId
    || claims.repository_owner !== input.binding.repositoryOwner
    || claims.repository_owner_id !== input.binding.accountId
    || claims.repository_visibility !== "private"
    || claims.workflow_ref !== expectedWorkflowRef
    || claims.workflow_sha !== input.binding.controlCommitSha
    || claims.sha !== input.binding.controlCommitSha
    || claims.ref !== input.binding.workflowControlRef
    || claims.run_id !== input.providerRunId
    || claims.run_attempt !== "1"
    || claims.check_run_id !== input.jobId
    || claims.event_name !== "workflow_dispatch"
    || claims.environment !== input.environment
    || claims.runner_environment !== input.binding.runnerEnvironment
    || Object.hasOwn(claims, "job_workflow_ref")
    || Object.hasOwn(claims, "job_workflow_sha")
    || typeof jti !== "string" || !/^[A-Za-z0-9._:-]{8,300}$/.test(jti)) {
    return fail("OIDC_CLAIMS_MISMATCH", "GitHub OIDC claims mismatch");
  }
  const normalizedClaims = {
    iss: claims.iss, aud: claims.aud, sub: claims.sub, repository: claims.repository,
    repositoryId: claims.repository_id, repositoryOwnerId: claims.repository_owner_id,
    workflowRef: claims.workflow_ref, workflowSha: claims.workflow_sha, ref: claims.ref,
    runId: claims.run_id, runAttempt: claims.run_attempt, jobId: claims.check_run_id,
    eventName: claims.event_name, environment: claims.environment,
    runnerEnvironment: claims.runner_environment, iat, nbf, exp,
  };
  return {
    providerRunId: input.providerRunId,
    jobId: input.jobId,
    environment: input.environment,
    jtiSha256: createHash("sha256").update(jti).digest("hex"),
    issuedAt: new Date(iat * 1_000),
    expiresAt: new Date(exp * 1_000),
    claimsSha256: createHash("sha256").update(JSON.stringify(normalizedClaims)).digest("hex"),
  };
}

const TARGET_REQUEST_KEYS = [
  "schemaVersion", "authorizationId", "operationId", "commandId", "attemptKey", "attestationId",
  "authorizationNonce", "expiresAt",
  "providerRunId", "jobId", "environment", "action", "snapshotSha256", "artifactManifestSha256",
  "workflowSha256", "environmentGeneration", "expectedCurrentReleaseVersionId", "oidcToken",
] as const;

export function parseRestrictedCicdTargetRequest(value: unknown): RestrictedCicdTargetRequest {
  if (!isObject(value) || !exactKeys(value, TARGET_REQUEST_KEYS)
    || value.schemaVersion !== "1"
    || !identifier(value.authorizationId) || !identifier(value.operationId) || !identifier(value.commandId)
    || !identifier(value.attemptKey) || !identifier(value.attestationId) || !identifier(value.authorizationNonce)
    || !exactIsoTimestamp(value.expiresAt)
    || typeof value.providerRunId !== "string" || !DECIMAL_ID.test(value.providerRunId)
    || typeof value.jobId !== "string" || !DECIMAL_ID.test(value.jobId)
    || (value.environment !== "staging" && value.environment !== "production")
    || (value.action !== "deploy" && value.action !== "rollback")
    || typeof value.snapshotSha256 !== "string" || !SHA256.test(value.snapshotSha256)
    || typeof value.artifactManifestSha256 !== "string" || !SHA256.test(value.artifactManifestSha256)
    || typeof value.workflowSha256 !== "string" || !SHA256.test(value.workflowSha256)
    || !Number.isSafeInteger(value.environmentGeneration) || Number(value.environmentGeneration) < 1
    || (value.expectedCurrentReleaseVersionId !== null && !identifier(value.expectedCurrentReleaseVersionId))
    || typeof value.oidcToken !== "string" || Buffer.byteLength(value.oidcToken) > MAX_TOKEN_BYTES) {
    return fail("TARGET_REQUEST_INVALID", "Restricted CI/CD target request invalid");
  }
  return value as RestrictedCicdTargetRequest;
}

const WORKFLOW_TARGET_REQUEST_KEYS = [
  "schemaVersion", "commandId", "releaseVersionId", "providerRunId", "jobId", "environment",
  "action", "artifactManifestSha256", "environmentGeneration", "controlCommitSha", "oidcToken",
] as const;

export function parseRestrictedCicdWorkflowTargetRequest(value: unknown): RestrictedCicdWorkflowTargetRequest {
  if (!isObject(value) || !exactKeys(value, WORKFLOW_TARGET_REQUEST_KEYS)
    || value.schemaVersion !== "2"
    || !identifier(value.commandId) || !identifier(value.releaseVersionId)
    || typeof value.providerRunId !== "string" || !DECIMAL_ID.test(value.providerRunId)
    || typeof value.jobId !== "string" || !DECIMAL_ID.test(value.jobId)
    || (value.environment !== "staging" && value.environment !== "production")
    || (value.action !== "deploy" && value.action !== "rollback")
    || typeof value.artifactManifestSha256 !== "string" || !SHA256.test(value.artifactManifestSha256)
    || !Number.isSafeInteger(value.environmentGeneration) || Number(value.environmentGeneration) < 1
    || typeof value.controlCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.controlCommitSha)
    || typeof value.oidcToken !== "string" || Buffer.byteLength(value.oidcToken) > MAX_TOKEN_BYTES) {
    return fail("TARGET_REQUEST_INVALID", "Restricted CI/CD workflow target request invalid");
  }
  return value as RestrictedCicdWorkflowTargetRequest;
}

export function parseRestrictedCicdTargetStopRequest(value: unknown): RestrictedCicdTargetStopRequest {
  if (!isObject(value) || !exactKeys(value, [
    "schemaVersion", "stopId", "environment", "actorKind", "actorIdentity", "reason",
  ]) || value.schemaVersion !== "1" || !identifier(value.stopId)
    || (value.environment !== "staging" && value.environment !== "production")
    || (value.actorKind !== "user" && value.actorKind !== "break_glass")
    || !identifier(value.actorIdentity)
    || typeof value.reason !== "string" || value.reason.length < 8 || value.reason.length > 500) {
    return fail("TARGET_STOP_REQUEST_INVALID", "Restricted CI/CD target stop request invalid");
  }
  return value as RestrictedCicdTargetStopRequest;
}

export function parseRestrictedCicdTargetClearRequest(value: unknown): RestrictedCicdTargetClearRequest {
  if (!isObject(value) || !exactKeys(value, [
    "schemaVersion", "stopId", "environment", "generation", "activationId",
    "expectedCurrentReleaseVersionId", "actorIdentity", "reason",
  ]) || value.schemaVersion !== "1" || !identifier(value.stopId)
    || (value.environment !== "staging" && value.environment !== "production")
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || !identifier(value.activationId)
    || (value.expectedCurrentReleaseVersionId !== null
      && !identifier(value.expectedCurrentReleaseVersionId))
    || !identifier(value.actorIdentity)
    || typeof value.reason !== "string" || value.reason.length < 8 || value.reason.length > 500) {
    return fail("TARGET_CLEAR_REQUEST_INVALID", "Restricted CI/CD target clear request invalid");
  }
  return value as RestrictedCicdTargetClearRequest;
}

export function createRestrictedCicdTargetDatabase(
  queryable: Queryable,
  dependencies: { now?: () => Date } = {},
) {
  return {
    async reserveWorkflow(request: RestrictedCicdWorkflowTargetRequest, oidc: VerifiedRestrictedCicdOidc, owner: {
      identitySha256: string;
      evidenceSha256: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
      auditorTrustSha256: string;
    }) {
      if (request.providerRunId !== oidc.providerRunId || request.jobId !== oidc.jobId
        || request.environment !== oidc.environment
        || !SHA256.test(owner.identitySha256) || !SHA256.test(owner.evidenceSha256)
        || !SHA256.test(owner.targetBindingSha256) || !SHA256.test(owner.receiptTrustSha256)
        || !SHA256.test(owner.auditorTrustSha256)) {
        return fail("TARGET_REQUEST_OIDC_MISMATCH", "Restricted CI/CD workflow target request OIDC mismatch");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_reserve_workflow_target_request_v4(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
        )
      `, [
        request.commandId, request.releaseVersionId, request.providerRunId, request.jobId,
        request.environment, request.action, request.artifactManifestSha256,
        request.environmentGeneration, request.controlCommitSha, oidc.jtiSha256,
        owner.identitySha256, owner.evidenceSha256, owner.targetBindingSha256,
        owner.receiptTrustSha256, owner.auditorTrustSha256,
      ]);
      const row = result.rows[0];
      const ownerEpoch = Number(row?.owner_epoch);
      const identityDigest = createHash("sha256").update([
        "restricted-cicd-workflow-target-v3", request.commandId, request.providerRunId,
        request.jobId, oidc.jtiSha256,
      ].join("\x1f")).digest("hex");
      const operationId = `operation-v3-${identityDigest.slice(0, 48)}`;
      const authorizationNonce = `nonce-v3-${identityDigest.slice(0, 48)}`;
      if (result.rows.length !== 1 || row.operation_id !== operationId
        || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || typeof row.replayed !== "boolean") {
        throw new Error("workflow target reservation gateway response invalid");
      }
      const snapshot = validateReleaseWorkflowExecutionSnapshot(
        row.execution_snapshot,
        dependencies.now?.() ?? new Date(),
      );
      if (snapshot.commandId !== request.commandId || snapshot.releaseVersionId !== request.releaseVersionId
        || snapshot.environment !== request.environment || snapshot.action !== request.action
        || snapshot.artifactManifestSha256 !== request.artifactManifestSha256
        || snapshot.environmentGeneration !== request.environmentGeneration
        || snapshot.controlCommitSha !== request.controlCommitSha) {
        return fail("TARGET_SNAPSHOT_MISMATCH", "Restricted CI/CD workflow execution snapshot mismatch");
      }
      return {
        operationId,
        ownerEpoch,
        replayed: row.replayed,
        identity: {
          commandId: snapshot.commandId,
          releaseVersionId: snapshot.releaseVersionId,
          runId: request.providerRunId,
          runAttempt: 1 as const,
          oidcJtiSha256: oidc.jtiSha256,
          authorizationNonce,
          operationId,
          environment: snapshot.environment,
          action: snapshot.action,
          workflowSha256: snapshot.workflowSha256,
          artifactManifestSha256: snapshot.artifactManifestSha256,
          snapshotSha256: snapshot.snapshotSha256,
          environmentGeneration: snapshot.environmentGeneration,
          expectedCurrentReleaseVersionId: snapshot.expectedCurrentReleaseVersionId,
        },
        deployment: {
          releaseTag: snapshot.releaseTag,
          releaseCommitSha: snapshot.releaseCommitSha,
          imageDigests: snapshot.imageDigests,
          migrationSetSha256: snapshot.migrationSetSha256,
          migrationVersion: snapshot.migrationVersion,
          hasIrreversibleMigrations: snapshot.hasIrreversibleMigrations,
        },
      };
    },
    async reserve(request: RestrictedCicdTargetRequest, oidc: VerifiedRestrictedCicdOidc, owner: {
      identitySha256: string;
      evidenceSha256: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
    }) {
      const requestExpiry = new Date(request.expiresAt);
      if (request.providerRunId !== oidc.providerRunId || request.jobId !== oidc.jobId
        || request.environment !== oidc.environment || requestExpiry > oidc.expiresAt
        || !SHA256.test(owner.identitySha256) || !SHA256.test(owner.evidenceSha256)
        || !SHA256.test(owner.targetBindingSha256) || !SHA256.test(owner.receiptTrustSha256)) {
        return fail("TARGET_REQUEST_OIDC_MISMATCH", "Restricted CI/CD target request OIDC mismatch");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_reserve_exact_target_request_v2(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
        )
      `, [
        request.authorizationId, request.operationId, request.commandId, request.attemptKey,
        request.attestationId, request.providerRunId, request.environment, request.action,
        request.snapshotSha256, request.artifactManifestSha256, request.workflowSha256,
        request.environmentGeneration, request.expectedCurrentReleaseVersionId, oidc.jtiSha256,
        request.authorizationNonce, owner.identitySha256,
        owner.evidenceSha256, owner.targetBindingSha256, owner.receiptTrustSha256, requestExpiry,
      ]);
      if (result.rows.length !== 1 || typeof result.rows[0].replayed !== "boolean") {
        throw new Error("target reservation gateway response invalid");
      }
      const ownerEpoch = Number(result.rows[0].owner_epoch);
      if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || result.rows[0].operation_id !== request.operationId) {
        throw new Error("target reservation gateway response invalid");
      }
      const snapshot = validateReleaseWorkflowExecutionSnapshot(
        result.rows[0].execution_snapshot,
        dependencies.now?.() ?? new Date(),
      );
      if (snapshot.commandId !== request.commandId || snapshot.environment !== request.environment
        || snapshot.action !== request.action || snapshot.snapshotSha256 !== request.snapshotSha256
        || snapshot.artifactManifestSha256 !== request.artifactManifestSha256
        || snapshot.workflowSha256 !== request.workflowSha256
        || snapshot.environmentGeneration !== request.environmentGeneration
        || snapshot.expectedCurrentReleaseVersionId !== request.expectedCurrentReleaseVersionId) {
        return fail("TARGET_SNAPSHOT_MISMATCH", "Restricted CI/CD execution snapshot mismatch");
      }
      return {
        operationId: request.operationId,
        ownerEpoch,
        replayed: result.rows[0].replayed,
        identity: {
          commandId: snapshot.commandId,
          releaseVersionId: snapshot.releaseVersionId,
          runId: request.providerRunId,
          runAttempt: 1 as const,
          oidcJtiSha256: oidc.jtiSha256,
          authorizationNonce: request.authorizationNonce,
          operationId: request.operationId,
          environment: snapshot.environment,
          action: snapshot.action,
          workflowSha256: snapshot.workflowSha256,
          artifactManifestSha256: snapshot.artifactManifestSha256,
          snapshotSha256: snapshot.snapshotSha256,
          environmentGeneration: snapshot.environmentGeneration,
          expectedCurrentReleaseVersionId: snapshot.expectedCurrentReleaseVersionId,
        },
        deployment: {
          releaseTag: snapshot.releaseTag,
          releaseCommitSha: snapshot.releaseCommitSha,
          imageDigests: snapshot.imageDigests,
          migrationSetSha256: snapshot.migrationSetSha256,
          migrationVersion: snapshot.migrationVersion,
          hasIrreversibleMigrations: snapshot.hasIrreversibleMigrations,
        },
      };
    },
    async takeover(input: {
      takeoverId: string;
      operationId: string;
      expectedOwnerEpoch: number;
      newOwnerEpoch: number;
      ownerIdentitySha256: string;
      evidenceSha256: string;
      reason: string;
    }) {
      if (!identifier(input.takeoverId) || !identifier(input.operationId)
        || !Number.isSafeInteger(input.expectedOwnerEpoch) || input.expectedOwnerEpoch < 1
        || input.newOwnerEpoch !== input.expectedOwnerEpoch + 1
        || !SHA256.test(input.ownerIdentitySha256) || !SHA256.test(input.evidenceSha256)
        || typeof input.reason !== "string" || input.reason.length < 10 || input.reason.length > 500) {
        return fail("TARGET_TAKEOVER_INVALID", "Restricted CI/CD target takeover invalid");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_takeover_target_operation($1,$2,$3,$4,$5,$6,$7)
      `, [
        input.takeoverId, input.operationId, input.expectedOwnerEpoch, input.newOwnerEpoch,
        input.ownerIdentitySha256, input.evidenceSha256, input.reason,
      ]);
      const row = result.rows[0];
      const ownerEpoch = Number(row?.owner_epoch);
      if (result.rows.length !== 1 || ownerEpoch !== input.newOwnerEpoch || typeof row.replayed !== "boolean") {
        throw new Error("target takeover gateway response invalid");
      }
      return { ownerEpoch, replayed: row.replayed };
    },
    async recover(input: {
      operationId: string;
      commandId: string;
      ownerIdentitySha256: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
    }) {
      if (!identifier(input.operationId) || !identifier(input.commandId)
        || !SHA256.test(input.ownerIdentitySha256) || !SHA256.test(input.targetBindingSha256)
        || !SHA256.test(input.receiptTrustSha256)) {
        return fail("TARGET_RECOVERY_INVALID", "Restricted CI/CD target recovery invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_recover_target_operation_v2($1,$2,$3,$4)",
        [input.operationId, input.ownerIdentitySha256, input.targetBindingSha256, input.receiptTrustSha256],
      );
      const row = result.rows[0];
      const ownerEpoch = Number(row?.owner_epoch);
      const snapshot = validateReleaseWorkflowExecutionSnapshot(
        row?.execution_snapshot,
        // Recovery may need to reconcile an already-applied physical cutover after the snapshot expired.
        new Date(String((row?.execution_snapshot as Record<string, unknown> | undefined)?.approvedAt ?? "")),
      );
      if (result.rows.length !== 1 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1
        || snapshot.commandId !== input.commandId || !DECIMAL_ID.test(String(row.run_id))
        || typeof row.oidc_jti_sha256 !== "string" || !SHA256.test(row.oidc_jti_sha256)
        || !identifier(row.authorization_nonce)) {
        throw new Error("target recovery gateway response invalid");
      }
      return {
        operationId: input.operationId,
        ownerEpoch,
        identity: {
          commandId: snapshot.commandId,
          releaseVersionId: snapshot.releaseVersionId,
          runId: String(row.run_id),
          runAttempt: 1 as const,
          oidcJtiSha256: row.oidc_jti_sha256 as string,
          authorizationNonce: row.authorization_nonce as string,
          operationId: input.operationId,
          environment: snapshot.environment,
          action: snapshot.action,
          workflowSha256: snapshot.workflowSha256,
          artifactManifestSha256: snapshot.artifactManifestSha256,
          snapshotSha256: snapshot.snapshotSha256,
          environmentGeneration: snapshot.environmentGeneration,
          expectedCurrentReleaseVersionId: snapshot.expectedCurrentReleaseVersionId,
        },
        deployment: {
          releaseTag: snapshot.releaseTag,
          releaseCommitSha: snapshot.releaseCommitSha,
          imageDigests: snapshot.imageDigests,
          migrationSetSha256: snapshot.migrationSetSha256,
          migrationVersion: snapshot.migrationVersion,
          hasIrreversibleMigrations: snapshot.hasIrreversibleMigrations,
        },
      };
    },
    async listRecoverable(input: {
      environment: "staging" | "production";
      ownerIdentitySha256: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
    }) {
      if ((input.environment !== "staging" && input.environment !== "production")
        || !SHA256.test(input.ownerIdentitySha256) || !SHA256.test(input.targetBindingSha256)
        || !SHA256.test(input.receiptTrustSha256)) {
        return fail("TARGET_RECOVERY_INVALID", "Restricted CI/CD target recovery query invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_list_recoverable_target_operations_v2($1,$2,$3,$4)",
        [input.environment, input.ownerIdentitySha256, input.targetBindingSha256, input.receiptTrustSha256],
      );
      return result.rows.map((row) => {
        if (!identifier(row.operation_id) || !identifier(row.command_id)) {
          throw new Error("target recovery query response invalid");
        }
        return { operationId: row.operation_id as string, commandId: row.command_id as string };
      });
    },
    async validateAuthority(input: {
      operationId: string;
      ownerEpoch: number;
      snapshotSha256: string;
      environmentGeneration: number;
      expectedCurrentReleaseVersionId: string | null;
      releaseVersionId: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
    }) {
      if (!identifier(input.operationId) || !identifier(input.releaseVersionId)
        || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1
        || !SHA256.test(input.snapshotSha256) || !SHA256.test(input.targetBindingSha256)
        || !SHA256.test(input.receiptTrustSha256)
        || !Number.isSafeInteger(input.environmentGeneration) || input.environmentGeneration < 1
        || (input.expectedCurrentReleaseVersionId !== null
          && !identifier(input.expectedCurrentReleaseVersionId))) {
        return fail("TARGET_AUTHORITY_INVALID", "Restricted CI/CD target authority validation invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_validate_target_authority_v2($1,$2,$3,$4,$5,$6,$7)",
        [input.operationId, input.ownerEpoch, input.snapshotSha256, input.environmentGeneration,
          input.expectedCurrentReleaseVersionId, input.targetBindingSha256, input.receiptTrustSha256],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row.release_version_id !== input.releaseVersionId) {
        throw new Error("target authority gateway response invalid");
      }
      return { releaseVersionId: input.releaseVersionId };
    },
    async validateCutover(input: {
      operationId: string;
      ownerEpoch: number;
      snapshotSha256: string;
      environmentGeneration: number;
      expectedCurrentReleaseVersionId: string | null;
      releaseVersionId: string;
      targetBindingSha256: string;
      receiptTrustSha256: string;
      backupId: string;
      backupSha256: string;
      restoreTocSha256: string;
      restorePlanSha256: string;
      backupCreatedAt: Date;
    }) {
      if (!identifier(input.operationId) || !identifier(input.releaseVersionId)
        || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1
        || !SHA256.test(input.snapshotSha256) || !SHA256.test(input.targetBindingSha256)
        || !SHA256.test(input.receiptTrustSha256) || !identifier(input.backupId)
        || !SHA256.test(input.backupSha256) || !SHA256.test(input.restoreTocSha256)
        || !SHA256.test(input.restorePlanSha256) || !Number.isFinite(input.backupCreatedAt.getTime())
        || !Number.isSafeInteger(input.environmentGeneration) || input.environmentGeneration < 1
        || (input.expectedCurrentReleaseVersionId !== null
          && !identifier(input.expectedCurrentReleaseVersionId))) {
        return fail("TARGET_CUTOVER_INVALID", "Restricted CI/CD target cutover validation invalid");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_validate_target_cutover_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        input.operationId, input.ownerEpoch, input.snapshotSha256,
        input.environmentGeneration, input.expectedCurrentReleaseVersionId,
        input.targetBindingSha256, input.receiptTrustSha256, input.backupId, input.backupSha256,
        input.restoreTocSha256, input.restorePlanSha256, input.backupCreatedAt,
      ]);
      const row = result.rows[0];
      const validatedAt = row?.validated_at instanceof Date
        ? row.validated_at
        : new Date(String(row?.validated_at));
      if (result.rows.length !== 1 || row.release_version_id !== input.releaseVersionId
        || !Number.isFinite(validatedAt.getTime())) {
        throw new Error("target cutover gateway response invalid");
      }
      return { releaseVersionId: input.releaseVersionId, validatedAt };
    },
    async requestStop(request: RestrictedCicdTargetStopRequest) {
      const parsed = parseRestrictedCicdTargetStopRequest(request);
      const result = await queryable.query(
        "SELECT * FROM release_workflow_target_request_stop($1,$2,$3,$4,$5)",
        [parsed.stopId, parsed.environment, parsed.actorKind, parsed.actorIdentity, parsed.reason],
      );
      const row = result.rows[0];
      const generation = Number(row?.generation);
      const requestedAt = row?.requested_at instanceof Date
        ? row.requested_at : new Date(String(row?.requested_at));
      if (result.rows.length !== 1 || !Number.isSafeInteger(generation) || generation < 1
        || !Number.isFinite(requestedAt.getTime()) || typeof row.replayed !== "boolean"
        || (row.expected_current_release_version_id !== null
          && !identifier(row.expected_current_release_version_id))) {
        throw new Error("target stop gateway response invalid");
      }
      return {
        generation,
        expectedCurrentReleaseVersionId: row.expected_current_release_version_id as string | null,
        requestedAt,
        replayed: row.replayed as boolean,
      };
    },
    async prepareClearAcknowledgement(request: RestrictedCicdTargetClearRequest, receiptTrustSha256: string) {
      const parsed = parseRestrictedCicdTargetClearRequest(request);
      if (!SHA256.test(receiptTrustSha256)) {
        return fail("TARGET_CLEAR_REQUEST_INVALID", "Restricted CI/CD target clear request invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_prepare_target_clear_ack_v2($1,$2,$3,$4,$5,$6)",
        [parsed.stopId, parsed.environment, parsed.generation, parsed.activationId,
          parsed.expectedCurrentReleaseVersionId, receiptTrustSha256],
      );
      const row = result.rows[0];
      const stopRequestedAt = row?.stop_requested_at instanceof Date
        ? row.stop_requested_at : new Date(String(row?.stop_requested_at));
      if (result.rows.length !== 1 || !Number.isFinite(stopRequestedAt.getTime())) {
        throw new Error("target clear acknowledgement gateway response invalid");
      }
      return { stopRequestedAt };
    },
    async validateStopCleared(request: RestrictedCicdTargetClearRequest, receiptTrustSha256: string) {
      const parsed = parseRestrictedCicdTargetClearRequest(request);
      if (!SHA256.test(receiptTrustSha256)) {
        return fail("TARGET_CLEAR_REQUEST_INVALID", "Restricted CI/CD target clear request invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_validate_target_stop_cleared_v2($1,$2,$3,$4,$5)",
        [parsed.stopId, parsed.environment, parsed.generation, parsed.activationId, receiptTrustSha256],
      );
      const row = result.rows[0];
      const clearedGeneration = Number(row?.cleared_generation);
      const clearedAt = row?.cleared_at instanceof Date ? row.cleared_at : new Date(String(row?.cleared_at));
      if (result.rows.length !== 1 || clearedGeneration !== parsed.generation + 1
        || !Number.isFinite(clearedAt.getTime())
        || (row.expected_current_release_version_id !== null
          && !identifier(row.expected_current_release_version_id))) {
        throw new Error("target stop clear validation response invalid");
      }
      return {
        clearedGeneration,
        expectedCurrentReleaseVersionId: row.expected_current_release_version_id as string | null,
        clearedAt,
      };
    },
    async appendStopReceipt(input: {
      receiptId: string;
      signed: {
        payload: Record<string, unknown>;
        payloadSha256: string;
        signature: string;
      };
      publicKey: KeyObject;
      receiptTrustSha256: string;
    }) {
      const payload = input.signed.payload;
      const canonicalSha256 = createHash("sha256")
        .update(canonicalizeRestrictedCicdReceipt(payload)).digest("hex");
      if (!identifier(input.receiptId) || payload.kind !== "target_stop_receipt"
        || payload.schemaVersion !== "1" || !identifier(payload.stopId)
        || (payload.environment !== "staging" && payload.environment !== "production")
        || !Number.isSafeInteger(payload.generation) || Number(payload.generation) < 1
        || (payload.phase !== "stop_committed" && payload.phase !== "clear_acknowledged")
        || (payload.phase === "stop_committed"
          ? payload.activationId !== null
          : !identifier(payload.activationId))
        || (payload.expectedCurrentReleaseVersionId !== null
          && !identifier(payload.expectedCurrentReleaseVersionId))
        || !identifier(payload.receiptNonce) || !identifier(payload.keyId)
        || (payload.actorKind !== "target" && payload.actorKind !== "break_glass")
        || typeof payload.actorFingerprintSha256 !== "string" || !SHA256.test(payload.actorFingerprintSha256)
        || !SHA256.test(input.receiptTrustSha256)
        || canonicalSha256 !== input.signed.payloadSha256
        || !verifyRestrictedCicdTargetReceiptSignature(payload, input.signed.signature, input.publicKey)) {
        return fail("TARGET_STOP_RECEIPT_INVALID", "Restricted CI/CD stop receipt invalid");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_append_stop_receipt_v2(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16
        )
      `, [
        input.receiptId, payload.stopId, payload.environment, payload.generation,
        payload.phase, payload.activationId, payload.expectedCurrentReleaseVersionId,
        payload.receiptNonce, payload.keyId, JSON.stringify(payload), input.signed.payloadSha256,
        input.signed.signature, payload.actorKind, payload.actorFingerprintSha256,
        input.receiptTrustSha256, true,
      ]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row?.stop_receipt_id !== input.receiptId
        || typeof row.replayed !== "boolean") {
        throw new Error("target stop receipt gateway response invalid");
      }
      return { receiptId: input.receiptId, replayed: row.replayed as boolean };
    },
    async assertMigrationRegistry(expectedSha256: string) {
      if (!SHA256.test(expectedSha256)) {
        return fail("TARGET_MIGRATION_REGISTRY_INVALID", "Migration registry digest invalid");
      }
      const result = await queryable.query(
        "SELECT * FROM release_workflow_assert_migration_registry($1)",
        [expectedSha256],
      );
      const row = result.rows[0];
      const count = Number(row?.migration_count);
      if (result.rows.length !== 1 || row.migration_registry_sha256 !== expectedSha256
        || !Number.isSafeInteger(count) || count < 1) {
        throw new Error("migration registry gateway response invalid");
      }
      return { migrationRegistrySha256: expectedSha256, migrationCount: count };
    },
    async appendReceipt(input: {
      receiptId: string;
      signed: SignedRestrictedCicdTargetReceipt;
      publicKey: KeyObject;
    }) {
      const payload = input.signed.payload;
      const canonicalSha256 = createHash("sha256")
        .update(canonicalizeRestrictedCicdReceipt(payload))
        .digest("hex");
      if (!identifier(input.receiptId) || !isObject(payload)
        || typeof payload.operationId !== "string" || !identifier(payload.operationId)
        || typeof payload.receiptNonce !== "string" || !identifier(payload.receiptNonce)
        || typeof payload.keyId !== "string" || !identifier(payload.keyId)
        || typeof payload.journalPhase !== "string"
        || !Number.isSafeInteger(payload.ownerEpoch) || Number(payload.ownerEpoch) < 1
        || !Number.isSafeInteger(payload.journalSequence) || Number(payload.journalSequence) < 1
        || (payload.actualPreviousReleaseVersionId !== null
          && !identifier(payload.actualPreviousReleaseVersionId))
        || (payload.actualCurrentReleaseVersionId !== null
          && !identifier(payload.actualCurrentReleaseVersionId))
        || canonicalSha256 !== input.signed.payloadSha256
        || !verifyRestrictedCicdTargetReceiptSignature(payload, input.signed.signature, input.publicKey)) {
        return fail("TARGET_RECEIPT_INVALID", "Restricted CI/CD target receipt invalid");
      }
      const result = await queryable.query(`
        SELECT * FROM release_workflow_append_target_receipt(
          $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
        )
      `, [
        input.receiptId, payload.operationId, payload.receiptNonce, payload.keyId,
        JSON.stringify(payload), input.signed.payloadSha256, input.signed.signature,
        payload.journalPhase, payload.ownerEpoch, payload.journalSequence,
        payload.actualPreviousReleaseVersionId, payload.actualCurrentReleaseVersionId, true,
      ]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row?.receipt_id !== input.receiptId || typeof row.replayed !== "boolean") {
        throw new Error("target receipt gateway response invalid");
      }
      return { receiptId: input.receiptId, replayed: row.replayed };
    },
  };
}
