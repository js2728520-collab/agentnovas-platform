import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";

import pg from "pg";

import {
  RestrictedCicdAuditorError,
  auditRestrictedCicdGithubRun,
  createRestrictedCicdAuditorDatabase,
  parseRestrictedCicdAuditorPolicy,
  parseRestrictedCicdAuditorRequest,
} from "../lib/restricted-cicd-auditor.ts";
import { createGithubAppJwt, loadGithubAppPrivateKey } from "../lib/restricted-cicd-github.ts";

if (process.env.RELEASE_AUDITOR_ENABLED !== "true") throw new Error("Restricted release auditor is disabled");

const APP_PERMISSIONS = Object.freeze({
  actions: "read",
  administration: "read",
  organization_self_hosted_runners: "read",
});
const API_BASE_URL = "https://api.github.com";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readCustodiedFile(filePath, minimum, maximum) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < minimum || metadata.size > maximum
    || (metadata.mode & 0o077) !== 0) throw new Error("Auditor credential custody invalid");
  return readFile(filePath);
}

function exactPermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = { ...value };
  if (actual.metadata === "read") delete actual.metadata;
  return Object.keys(actual).sort().join("|") === Object.keys(APP_PERMISSIONS).sort().join("|")
    && Object.entries(APP_PERMISSIONS).every(([key, permission]) => actual[key] === permission);
}

function numericIdentity(value, expected) {
  return (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected)
    || value === expected;
}

async function providerJson(policy, token, pathname, options = {}) {
  const url = new URL(pathname, API_BASE_URL);
  if (url.origin !== API_BASE_URL) throw new Error("Auditor provider endpoint invalid");
  const response = await fetch(url, {
    method: options.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      "content-type": "application/json", "user-agent": "agentnovas-release-provider-security-auditor/1",
      "x-github-api-version": policy.apiVersion,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status !== (options.status ?? 200)) throw new Error("Auditor provider unavailable");
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length"));
  if ((mediaType !== "application/json" && mediaType !== "application/vnd.github+json")
    || (Number.isFinite(declaredLength) && declaredLength > 256 * 1024)) {
    throw new Error("Auditor provider response invalid");
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Auditor provider response too large");
  return JSON.parse(body);
}

async function mintReadOnlyToken(policy, privateKey) {
  const appJwt = createGithubAppJwt(privateKey, policy.appId);
  const app = await providerJson(policy, appJwt, "/app");
  if (!numericIdentity(app?.id, policy.appId) || !numericIdentity(app?.owner?.id, policy.accountId)
    || app?.owner?.login !== policy.repositoryOwner || !exactPermissions(app?.permissions)) {
    throw new Error("Auditor App binding drift");
  }
  const installations = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await providerJson(policy, appJwt, `/app/installations?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Auditor installation response invalid");
    installations.push(...batch);
    if (batch.length < 100) break;
  }
  if (installations.length !== 1) throw new Error("Auditor installation binding drift");
  const installation = installations[0];
  if (!numericIdentity(installation?.id, policy.installationId)
    || !numericIdentity(installation?.app_id, policy.appId)
    || installation?.repository_selection !== "selected" || installation?.suspended_at !== null
    || !numericIdentity(installation?.account?.id, policy.accountId)
    || installation?.account?.login !== policy.repositoryOwner || !exactPermissions(installation?.permissions)) {
    throw new Error("Auditor installation binding drift");
  }
  const token = await providerJson(policy, appJwt, `/app/installations/${policy.installationId}/access_tokens`, {
    method: "POST", status: 201,
    body: { repository_ids: [Number(policy.repositoryId)], permissions: APP_PERMISSIONS },
  });
  if (typeof token?.token !== "string" || token.token.length < 1 || token.token.length > 8192
    || token.repository_selection !== "selected" || !exactPermissions(token.permissions)
    || !Array.isArray(token.repositories) || token.repositories.length !== 1
    || !numericIdentity(token.repositories[0]?.id, policy.repositoryId)
    || token.repositories[0]?.full_name !== `${policy.repositoryOwner}/${policy.repositoryName}`) {
    throw new Error("Auditor installation token drift");
  }
  const expiresAt = new Date(String(token.expires_at));
  const remaining = expiresAt.getTime() - Date.now();
  if (!Number.isFinite(expiresAt.getTime()) || remaining < 60_000 || remaining > 60 * 60_000) {
    throw new Error("Auditor installation token expiry drift");
  }
  return token.token;
}

function authorized(header, expected) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function receiveBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 16 * 1024) throw new Error("Auditor request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function respond(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(payload);
}

const databaseUrl = new URL(required("RELEASE_AUDITOR_DATABASE_URL"));
if (!(databaseUrl.protocol === "postgres:" || databaseUrl.protocol === "postgresql:")
  || databaseUrl.username !== "agentnovas_release_auditor") throw new Error("Auditor database role invalid");
const policy = parseRestrictedCicdAuditorPolicy(JSON.parse((await readCustodiedFile(required("RELEASE_AUDITOR_POLICY_FILE"), 100, 64 * 1024)).toString("utf8")));
const appPrivateKey = await loadGithubAppPrivateKey(required("RELEASE_AUDITOR_APP_PRIVATE_KEY_FILE"));
const attestationPrivateKey = createPrivateKey(await readCustodiedFile(required("RELEASE_AUDITOR_ATTESTATION_PRIVATE_KEY_FILE"), 64, 16 * 1024));
if (attestationPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("Auditor attestation key invalid");
const sharedSecret = (await readCustodiedFile(required("RELEASE_AUDITOR_SHARED_SECRET_FILE"), 32, 512)).toString("utf8").trim();
if (sharedSecret.length < 32) throw new Error("Auditor shared secret invalid");
const pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2, application_name: "agentnovas-release-provider-security-auditor",
  connectionTimeoutMillis: 1500, query_timeout: 6000, statement_timeout: 5000, lock_timeout: 2000 });
const database = createRestrictedCicdAuditorDatabase(pool);
const host = process.env.RELEASE_AUDITOR_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const port = Number(process.env.RELEASE_AUDITOR_PORT ?? 3316);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Auditor port invalid");

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return respond(response, 200, { ok: true, enabled: true });
    if (request.method !== "POST" || request.url !== "/internal/restricted-cicd/audit"
      || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      request.resume(); return respond(response, 404, { ok: false, code: "not_found" });
    }
    if (!authorized(request.headers.authorization, sharedSecret)) {
      request.resume(); return respond(response, 403, { ok: false, code: "auditor_caller_rejected" });
    }
    const auditorRequest = parseRestrictedCicdAuditorRequest(JSON.parse(await receiveBody(request)));
    const installationToken = await mintReadOnlyToken(policy, appPrivateKey);
    const result = await auditRestrictedCicdGithubRun({ policy, request: auditorRequest, installationToken,
      attestationPrivateKey, database });
    return respond(response, 200, { schemaVersion: "1", attestationId: result.attestationId,
      expiresAt: result.attestation.expiresAt, replayed: result.replayed });
  } catch (error) {
    const code = error instanceof RestrictedCicdAuditorError ? error.code.toLowerCase() : "auditor_unavailable";
    return respond(response, 403, { ok: false, code });
  }
});
server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
server.listen(port, host);
