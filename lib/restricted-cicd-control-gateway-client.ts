import { ResearchApiError } from "./research-errors.ts";
import { getPostgresPool } from "./postgres.ts";
import {
  parseRestrictedCicdHumanActionEnvelope,
  restrictedCicdHumanActionMutationDocument,
  restrictedCicdHumanActionMutationSha256,
  restrictedCicdHumanActionPermission,
  type RestrictedCicdControlOperation,
  type RestrictedCicdHumanActionEnvelope,
} from "./restricted-cicd-human-action.ts";
import type { RestrictedCicdWebAuthnAssertion } from "./restricted-cicd-webauthn.ts";

const ASSERTION_HEADERS = Object.freeze({
  challengeId: "x-release-webauthn-challenge-id",
  credentialId: "x-release-webauthn-credential-id",
  clientDataJSON: "x-release-webauthn-client-data",
  authenticatorData: "x-release-webauthn-authenticator-data",
  signature: "x-release-webauthn-signature",
  userHandle: "x-release-webauthn-user-handle",
});

function gatewayUrl(raw: string | undefined, environmentName: string, serviceHost: string, path: string) {
  if (!raw?.trim()) throw new ResearchApiError("RELEASE_CONTROL_UNAVAILABLE", `独立发布服务未配置：${environmentName}`, 503);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${environmentName} invalid`); }
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", serviceHost]);
  if (url.protocol !== "http:" || !allowedHosts.has(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${environmentName} must be an approved internal HTTP origin`);
  }
  return new URL(path, url);
}

function assertionFrom(request: Request): RestrictedCicdWebAuthnAssertion | undefined {
  const values = Object.fromEntries(Object.entries(ASSERTION_HEADERS).map(([key, header]) => [key, request.headers.get(header)]));
  const present = Object.values(values).filter((value) => value !== null).length;
  if (present === 0) return undefined;
  if (present < 5 || !values.challengeId || !values.credentialId || !values.clientDataJSON
    || !values.authenticatorData || !values.signature) {
    throw new ResearchApiError("WEBAUTHN_ASSERTION_INVALID", "人类动作签名字段不完整", 422);
  }
  return {
    challengeId: values.challengeId,
    credentialId: values.credentialId,
    clientDataJSON: values.clientDataJSON,
    authenticatorData: values.authenticatorData,
    signature: values.signature,
    ...(values.userHandle ? { userHandle: values.userHandle } : {}),
  };
}

async function internalRequest(url: URL, sharedSecret: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sharedSecret}` },
      body: JSON.stringify(body), cache: "no-store", signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      result?: unknown;
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (!response.ok) throw new ResearchApiError(
      payload.error?.code ?? "RELEASE_CONTROL_REJECTED",
      payload.error?.message ?? "独立发布服务拒绝请求",
      response.status,
      payload.error?.details ?? {},
    );
    return payload.result;
  } catch (error) {
    if (error instanceof ResearchApiError) throw error;
    throw new ResearchApiError("RELEASE_CONTROL_UNAVAILABLE", "独立发布服务暂不可用", 503);
  } finally { clearTimeout(timeout); }
}

function sharedSecret(environment: Record<string, string | undefined>, name: string) {
  const value = environment[name]?.trim();
  if (!value || value.length < 32 || value.length > 512) {
    throw new ResearchApiError("RELEASE_CONTROL_UNAVAILABLE", `独立发布服务认证未配置：${name}`, 503);
  }
  return value;
}

async function issueAuthority(envelope: RestrictedCicdHumanActionEnvelope, mutationSha256: string) {
  const pool = await getPostgresPool();
  const result = await pool.query<{ authority_id: string }>(`SELECT * FROM release_workflow_issue_human_action_authority(
    $1,$2,$3,$4,$5,$6,$7
  )`, [
    envelope.actorUserId,envelope.sessionSecret,restrictedCicdHumanActionPermission(envelope),envelope.operation,
    mutationSha256,envelope.idempotencyKey,envelope.requestId,
  ]);
  const authorityId = result.rows[0]?.authority_id;
  if (!authorityId) throw new ResearchApiError("RELEASE_IDENTITY_REJECTED", "未形成一次性发布身份授权", 422);
  return authorityId;
}

export async function invokeRestrictedCicdControlGateway(input: {
  request: Request;
  operation: RestrictedCicdControlOperation;
  actorUserId: string;
  sessionSecret: string;
  idempotencyKey: string;
  requestId: string;
  parameters?: Record<string, string>;
  body: unknown;
}, environment: Record<string, string | undefined> = process.env, dependencies: {
  issueAuthority?: (envelope: RestrictedCicdHumanActionEnvelope, mutationSha256: string) => Promise<string>;
} = {}) {
  const envelope = parseRestrictedCicdHumanActionEnvelope({
    schemaVersion: "1", operation: input.operation, actorUserId: input.actorUserId,
    sessionSecret: input.sessionSecret, idempotencyKey: input.idempotencyKey,
    requestId: input.requestId, parameters: input.parameters ?? {}, body: input.body,
  });
  const mutationDocument = restrictedCicdHumanActionMutationDocument(envelope);
  const mutationSha256 = restrictedCicdHumanActionMutationSha256(envelope);
  const authorityId = await (dependencies.issueAuthority ?? issueAuthority)(envelope, mutationSha256);
  const assertion = assertionFrom(input.request);
  const identityResult = await internalRequest(
    gatewayUrl(environment.RELEASE_IDENTITY_VERIFIER_URL, "RELEASE_IDENTITY_VERIFIER_URL", "release-identity-verifier", "/v1/assertions"),
    sharedSecret(environment, "RELEASE_IDENTITY_VERIFIER_SHARED_SECRET"),
    { schemaVersion: "1", authorityId, mutationDocument, ...(assertion ? { assertion } : {}) },
  ) as { assertionId?: string; mutationSha256?: string };
  if (!identityResult?.assertionId || !identityResult.mutationSha256) {
    throw new ResearchApiError("RELEASE_IDENTITY_REJECTED", "人类动作签名未形成可消费授权", 422);
  }
  return internalRequest(
    gatewayUrl(environment.RELEASE_CONTROL_GATEWAY_URL, "RELEASE_CONTROL_GATEWAY_URL", "release-control", "/v1/mutations"),
    sharedSecret(environment, "RELEASE_CONTROL_GATEWAY_SHARED_SECRET"),
    { schemaVersion: "1", envelope, assertionId: identityResult.assertionId, mutationSha256: identityResult.mutationSha256 },
  );
}
