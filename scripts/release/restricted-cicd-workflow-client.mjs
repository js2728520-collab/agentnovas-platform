#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

function targetUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Restricted CI/CD target URL invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port
    || url.search || url.hash || url.pathname !== "/internal/restricted-cicd/deploy") {
    throw new Error("Restricted CI/CD target URL invalid");
  }
  return url;
}

function audience(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Restricted CI/CD OIDC audience invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("Restricted CI/CD OIDC audience invalid");
  return url.href.replace(/\/$/, "");
}

function oidcRequestUrl(raw, expectedAudience) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("GitHub OIDC request URL invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "token.actions.githubusercontent.com"
    || url.username || url.password || url.hash) throw new Error("GitHub OIDC request URL invalid");
  url.searchParams.set("audience", expectedAudience);
  return url;
}

async function boundedJson(response) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new Error("Restricted CI/CD response invalid");
  const body = await response.arrayBuffer();
  if (body.byteLength < 2 || body.byteLength > MAX_RESPONSE_BYTES) throw new Error("Restricted CI/CD response invalid");
  try { return JSON.parse(Buffer.from(body).toString("utf8")); } catch { throw new Error("Restricted CI/CD response invalid"); }
}

function tokenContext(token) {
  if (typeof token !== "string" || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new Error("GitHub OIDC token invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("GitHub OIDC token invalid");
  }
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("payload");
    return value;
  } catch {
    throw new Error("GitHub OIDC token invalid");
  }
}

function input(environment) {
  const generation = Number(environment.INPUT_ENVIRONMENT_GENERATION);
  if (environment.INPUT_SCHEMA_VERSION !== "2"
    || !IDENTIFIER.test(environment.INPUT_COMMAND_ID ?? "")
    || !IDENTIFIER.test(environment.INPUT_RELEASE_VERSION_ID ?? "")
    || (environment.INPUT_ENVIRONMENT !== "staging" && environment.INPUT_ENVIRONMENT !== "production")
    || (environment.INPUT_ACTION !== "deploy" && environment.INPUT_ACTION !== "rollback")
    || !SHA256.test(environment.INPUT_ARTIFACT_MANIFEST_SHA256 ?? "")
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Restricted CI/CD workflow input invalid");
  }
  if (!DECIMAL.test(environment.GITHUB_RUN_ID ?? "") || environment.GITHUB_RUN_ATTEMPT !== "1"
    || !COMMIT.test(environment.GITHUB_SHA ?? "")) {
    throw new Error("Restricted CI/CD workflow context invalid");
  }
  return {
    commandId: environment.INPUT_COMMAND_ID,
    releaseVersionId: environment.INPUT_RELEASE_VERSION_ID,
    environment: environment.INPUT_ENVIRONMENT,
    action: environment.INPUT_ACTION,
    artifactManifestSha256: environment.INPUT_ARTIFACT_MANIFEST_SHA256,
    environmentGeneration: generation,
    providerRunId: environment.GITHUB_RUN_ID,
    controlCommitSha: environment.GITHUB_SHA,
  };
}

export async function runRestrictedCicdWorkflowClient(environment, dependencies = {}) {
  const parsed = input(environment);
  const destination = targetUrl(environment.RESTRICTED_CICD_TARGET_URL ?? "");
  const expectedAudience = audience(environment.RESTRICTED_CICD_OIDC_AUDIENCE ?? "");
  if (destination.origin !== expectedAudience) throw new Error("Restricted CI/CD target URL invalid");
  if (typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string"
    || environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length < 8
    || environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 8192) {
    throw new Error("GitHub OIDC request credential invalid");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const oidcResponse = await fetchImpl(oidcRequestUrl(
    environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "", expectedAudience,
  ), {
    method: "GET",
    headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (oidcResponse.status !== 200) throw new Error("GitHub OIDC token unavailable");
  const oidcBody = await boundedJson(oidcResponse);
  const oidcToken = oidcBody?.value;
  const claims = tokenContext(oidcToken);
  if (claims.run_id !== parsed.providerRunId || claims.run_attempt !== "1"
    || !DECIMAL.test(claims.check_run_id ?? "") || claims.environment !== parsed.environment) {
    throw new Error("GitHub OIDC workflow context mismatch");
  }
  const request = {
    schemaVersion: "2",
    commandId: parsed.commandId,
    releaseVersionId: parsed.releaseVersionId,
    providerRunId: parsed.providerRunId,
    jobId: claims.check_run_id,
    environment: parsed.environment,
    action: parsed.action,
    artifactManifestSha256: parsed.artifactManifestSha256,
    environmentGeneration: parsed.environmentGeneration,
    controlCommitSha: parsed.controlCommitSha,
    oidcToken,
  };
  const targetResponse = await fetchImpl(destination, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(request),
  });
  if (targetResponse.status !== 200) throw new Error("Restricted CI/CD target did not verify deployment");
  const outcome = await boundedJson(targetResponse);
  if (!outcome || outcome.ok !== true || !IDENTIFIER.test(outcome.operationId ?? "")
    || outcome.phase !== "health_verified" || typeof outcome.replayed !== "boolean") {
    throw new Error("Restricted CI/CD target response invalid");
  }
  return { operationId: outcome.operationId, phase: outcome.phase, replayed: outcome.replayed };
}

async function main() {
  const result = await runRestrictedCicdWorkflowClient(process.env);
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Restricted CI/CD workflow failed"}\n`);
    process.exitCode = 1;
  });
}
