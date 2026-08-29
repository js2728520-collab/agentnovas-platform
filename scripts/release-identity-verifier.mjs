import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { getReleaseIdentityVerifierPostgresPool } from "../lib/postgres.ts";
import {
  parseRestrictedCicdHumanActionMutationDocument,
  restrictedCicdHumanActionPermission,
} from "../lib/restricted-cicd-human-action.ts";
import {
  parseRestrictedCicdWebAuthnAssertion,
  parseRestrictedCicdWebAuthnPolicy,
  restrictedCicdWebAuthnAssertionSha256,
  verifyRestrictedCicdWebAuthnAssertion,
} from "../lib/restricted-cicd-webauthn.ts";

if (process.env.RELEASE_IDENTITY_VERIFIER_ENABLED !== "true") throw new Error("Restricted release identity verifier is disabled");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numericPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("RELEASE_IDENTITY_VERIFIER_PORT invalid");
  return port;
}

async function readCustodiedPolicy(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 100 || metadata.size > 512 * 1024
    || (metadata.mode & 0o022) !== 0) throw new Error("Release identity WebAuthn policy custody invalid");
  const source = await readFile(filePath, "utf8");
  return { policy: parseRestrictedCicdWebAuthnPolicy(JSON.parse(source)), policySha256: createHash("sha256").update(source).digest("hex") };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error(`${label} invalid`);
  return value;
}

function receiveBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 128 * 1024) { reject(new Error("body limit")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(payload);
}

function authorized(header, expected) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const host = process.env.RELEASE_IDENTITY_VERIFIER_HOST?.trim() || "127.0.0.1";
if (!new Set(["127.0.0.1", "0.0.0.0"]).has(host)) throw new Error("RELEASE_IDENTITY_VERIFIER_HOST invalid");
const port = numericPort(process.env.RELEASE_IDENTITY_VERIFIER_PORT?.trim() || "3315");
const sharedSecret = required("RELEASE_IDENTITY_VERIFIER_SHARED_SECRET");
if (sharedSecret.length < 32 || sharedSecret.length > 512) throw new Error("RELEASE_IDENTITY_VERIFIER_SHARED_SECRET invalid");
const { policy, policySha256 } = await readCustodiedPolicy(required("RELEASE_IDENTITY_VERIFIER_WEBAUTHN_POLICY_FILE"));
const pool = await getReleaseIdentityVerifierPostgresPool();
const challenges = new Map();
const counters = new Map();

function purgeChallenges(now = Date.now()) {
  for (const [id, challenge] of challenges) if (challenge.expiresAt + 5 * 60_000 < now) challenges.delete(id);
  while (challenges.size > 1000) challenges.delete(challenges.keys().next().value);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return respond(response, 200, { ok: true, enabled: true });
    if (request.method !== "POST" || request.url !== "/v1/assertions") return respond(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    if (!authorized(request.headers.authorization, sharedSecret)) return respond(response, 403, { error: { code: "FORBIDDEN", message: "Release identity caller rejected" } });
    const body = JSON.parse(await receiveBody(request));
    const requestBody = exactObject(body, body && Object.hasOwn(body, "assertion")
      ? ["schemaVersion", "authorityId", "mutationDocument", "assertion"]
      : ["schemaVersion", "authorityId", "mutationDocument"], "Release identity request");
    if (requestBody.schemaVersion !== "1") throw new Error("Release identity schema invalid");
    const authorityId = typeof requestBody.authorityId === "string" ? requestBody.authorityId : "";
    if (!/^release-authority-[a-f0-9]{48}$/u.test(authorityId)) throw new Error("Release identity authority invalid");
    const mutation = parseRestrictedCicdHumanActionMutationDocument(requestBody.mutationDocument);
    const digest = createHash("sha256").update(requestBody.mutationDocument).digest("hex");
    const permission = restrictedCicdHumanActionPermission(mutation);
    const actorCredentials = policy.credentials.filter((credential) => credential.userId === mutation.actorUserId);
    if (actorCredentials.length < 1) return respond(response, 403, { error: { code: "HUMAN_CREDENTIAL_REQUIRED", message: "当前人员未登记发布动作凭证" } });
    const resolved = await pool.query(`SELECT * FROM release_workflow_resolve_human_action_assertion(
      $1,$2,$3,$4,$5,$6
    )`, [authorityId,mutation.actorUserId,mutation.operation,digest,mutation.idempotencyKey,mutation.requestId]);
    if (resolved.rows[0]?.assertion_id) {
      return respond(response, 200, { result: { assertionId: resolved.rows[0].assertion_id, mutationSha256: digest } });
    }
    purgeChallenges();
    if (!requestBody.assertion) {
      const challengeId = `release-assertion-${randomUUID()}`;
      const challenge = randomBytes(32).toString("base64url");
      challenges.set(challengeId, { challenge, digest, authorityId, actorUserId: mutation.actorUserId, permission, expiresAt: Date.now() + 2 * 60_000 });
      return respond(response, 428, { error: { code: "WEBAUTHN_ACTION_REQUIRED", message: "请用已登记的人类凭证确认本次精确发布动作", details: {
        webAuthn: { challengeId, challenge, rpId: policy.rpId, credentialIds: actorCredentials.map((credential) => credential.credentialId),
          timeout: 120000, userVerification: "required" },
      } } });
    }
    const assertion = parseRestrictedCicdWebAuthnAssertion(requestBody.assertion);
    const challenge = challenges.get(assertion.challengeId);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.digest !== digest || challenge.authorityId !== authorityId
      || challenge.actorUserId !== mutation.actorUserId || challenge.permission !== permission) {
      return respond(response, 409, { error: { code: "WEBAUTHN_CHALLENGE_INVALID", message: "人类动作挑战已失效或与请求不一致" } });
    }
    const verified = verifyRestrictedCicdWebAuthnAssertion({ policy, assertion, expectedChallenge: challenge.challenge,
      expectedUserId: mutation.actorUserId, previousSignCount: counters.get(assertion.credentialId) ?? 0 });
    counters.set(assertion.credentialId, Math.max(counters.get(assertion.credentialId) ?? 0, verified.signCount));
    const assertionSha256 = restrictedCicdWebAuthnAssertionSha256(assertion);
    const result = await pool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    )`, [
      assertion.challengeId,authorityId,mutation.actorUserId,permission,mutation.operation,digest,
      assertionSha256,createHash("sha256").update(assertion.credentialId).digest("hex"),
      createHash("sha256").update(verified.origin).digest("hex"),verified.signCount,
      mutation.idempotencyKey,mutation.requestId,new Date(),new Date(challenge.expiresAt),policySha256,
      assertion.credentialId,assertion.clientDataJSON,assertion.authenticatorData,assertion.signature,
    ]);
    challenges.delete(assertion.challengeId);
    return respond(response, 200, { result: { assertionId: result.rows[0]?.assertion_id, mutationSha256: digest } });
  } catch {
    return respond(response, 422, { error: { code: "RELEASE_IDENTITY_REJECTED", message: "Release identity verification rejected" } });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host);

async function shutdown() { server.close(); await pool.end(); }
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
