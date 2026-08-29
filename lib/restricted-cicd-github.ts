import {
  createHash,
  createPrivateKey,
  createSign,
  type KeyObject,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildReleaseWorkflowDispatchEnvelope,
  type ReleaseWorkflowAction,
  type ReleaseWorkflowEnvironment,
} from "./restricted-cicd-domain.ts";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const EXACT_APP_PERMISSIONS = { actions: "write", contents: "read" } as const;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_WORKFLOW_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

type JsonObject = Record<string, unknown>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const BINDING_KEYS = [
  "provider", "apiVersion", "apiBaseUrl", "repositoryOwner", "repositoryName", "repositoryId",
  "appId", "installationId", "accountId", "appPrivateKeyFile", "workflowId", "workflowPath",
  "workflowControlRef", "controlCommitSha", "workflowSha256", "environment", "oidcAudience", "runnerEnvironment",
  "g7ManifestSha256", "providerBindingSha256", "environmentPolicySha256",
  "productionReviewerAllowlistSha256", "runnerPolicySha256", "targetBindingSha256",
  "receiptTrustSha256", "auditorTrustSha256",
] as const;

export type RestrictedCicdGithubBinding = {
  provider: "github_actions";
  apiVersion: "2026-03-10";
  apiBaseUrl: "https://api.github.com";
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string;
  appId: string;
  installationId: string;
  accountId: string;
  appPrivateKeyFile: string;
  workflowId: string;
  workflowPath: string;
  workflowControlRef: string;
  controlCommitSha: string;
  workflowSha256: string;
  environment: ReleaseWorkflowEnvironment;
  oidcAudience: string;
  runnerEnvironment: "github-hosted" | "self-hosted";
  g7ManifestSha256: string;
  providerBindingSha256: string;
  environmentPolicySha256: string;
  productionReviewerAllowlistSha256: string;
  runnerPolicySha256: string;
  targetBindingSha256: string;
  receiptTrustSha256: string;
  auditorTrustSha256: string;
};

export type RestrictedCicdProviderBindingMaterial = {
  provider: "github_actions";
  apiVersion: "2026-03-10";
  apiBaseUrl: "https://api.github.com";
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string;
  appId: string;
  installationId: string;
  accountId: string;
  workflowId: string;
  workflowPath: string;
  workflowControlRef: string;
  controlCommitSha: string;
  workflowSha256: string;
  environment: ReleaseWorkflowEnvironment;
  oidcAudience: string;
  runnerEnvironment: "github-hosted" | "self-hosted";
};

export class RestrictedCicdGithubError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdGithubError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdGithubError(code, message);
}

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: JsonObject, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveDecimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function commitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function repoPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 100
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function workflowPath(value: unknown): value is string {
  return typeof value === "string"
    && /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ya?ml$/.test(value);
}

function protectedTagRef(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("refs/tags/") || value.length > 209) return false;
  const tag = value.slice("refs/tags/".length);
  return tag.length > 0
    && !tag.endsWith("/")
    && !tag.endsWith(".")
    && !tag.includes("//")
    && !tag.includes("..")
    && !tag.includes("@{")
    && ![...tag].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 32 || codePoint === 127 || "~^:?*[]".includes(character);
    })
    && !tag.includes("\\")
    && tag.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function exactHttpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function buildRestrictedCicdProviderBindingMaterial(
  binding: RestrictedCicdProviderBindingMaterial,
): RestrictedCicdProviderBindingMaterial {
  return {
    provider: binding.provider,
    apiVersion: binding.apiVersion,
    apiBaseUrl: binding.apiBaseUrl,
    repositoryOwner: binding.repositoryOwner,
    repositoryName: binding.repositoryName,
    repositoryId: binding.repositoryId,
    appId: binding.appId,
    installationId: binding.installationId,
    accountId: binding.accountId,
    workflowId: binding.workflowId,
    workflowPath: binding.workflowPath,
    workflowControlRef: binding.workflowControlRef,
    controlCommitSha: binding.controlCommitSha,
    workflowSha256: binding.workflowSha256,
    environment: binding.environment,
    oidcAudience: binding.oidcAudience,
    runnerEnvironment: binding.runnerEnvironment,
  };
}

export function computeRestrictedCicdProviderBindingSha256(
  binding: RestrictedCicdProviderBindingMaterial,
) {
  return createHash("sha256")
    .update(JSON.stringify(buildRestrictedCicdProviderBindingMaterial(binding)))
    .digest("hex");
}

export function parseRestrictedCicdGithubBinding(input: unknown): RestrictedCicdGithubBinding {
  if (!isObject(input) || !hasExactKeys(input, BINDING_KEYS)) {
    return fail("BINDING_INVALID", "GitHub provider binding invalid");
  }
  const valid = input.provider === "github_actions"
    && input.apiVersion === GITHUB_API_VERSION
    && input.apiBaseUrl === GITHUB_API_BASE_URL
    && repoPart(input.repositoryOwner)
    && repoPart(input.repositoryName)
    && positiveDecimal(input.repositoryId)
    && positiveDecimal(input.appId)
    && positiveDecimal(input.installationId)
    && positiveDecimal(input.accountId)
    && typeof input.appPrivateKeyFile === "string"
    && path.isAbsolute(input.appPrivateKeyFile)
    && input.appPrivateKeyFile.length <= 500
    && !input.appPrivateKeyFile.includes("\0")
    && positiveDecimal(input.workflowId)
    && workflowPath(input.workflowPath)
    && protectedTagRef(input.workflowControlRef)
    && commitSha(input.controlCommitSha)
    && sha256(input.workflowSha256)
    && (input.environment === "staging" || input.environment === "production")
    && exactHttpsUrl(input.oidcAudience)
    && (input.runnerEnvironment === "github-hosted" || input.runnerEnvironment === "self-hosted")
    && sha256(input.g7ManifestSha256)
    && sha256(input.providerBindingSha256)
    && sha256(input.environmentPolicySha256)
    && sha256(input.productionReviewerAllowlistSha256)
    && sha256(input.runnerPolicySha256)
    && sha256(input.targetBindingSha256)
    && sha256(input.receiptTrustSha256)
    && sha256(input.auditorTrustSha256);
  if (!valid) return fail("BINDING_INVALID", "GitHub provider binding invalid");
  const binding = input as RestrictedCicdGithubBinding;
  if (computeRestrictedCicdProviderBindingSha256(binding) !== binding.providerBindingSha256) {
    return fail("BINDING_INVALID", "GitHub provider binding invalid");
  }
  return binding;
}

export async function loadGithubAppPrivateKey(filePath: string): Promise<KeyObject> {
  try {
    if (!path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes("\0")) throw new Error("path");
    const metadata = await lstat(filePath);
    const permissions = metadata.mode & 0o7777;
    if (!metadata.isFile() || metadata.isSymbolicLink() || (permissions & 0o7337) !== 0) throw new Error("custody");
    if (metadata.size < 512 || metadata.size > 16 * 1024) throw new Error("size");
    const pem = await readFile(filePath, "utf8");
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("type");
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulusLength < 2048) throw new Error("strength");
    return key;
  } catch {
    return fail("PRIVATE_KEY_UNAVAILABLE", "GitHub App private key unavailable");
  }
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGithubAppJwt(privateKey: KeyObject, appId: string, now = new Date()) {
  if (privateKey.asymmetricKeyType !== "rsa"
    || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    || !positiveDecimal(appId)
    || !Number.isFinite(now.getTime())) {
    return fail("APP_JWT_UNAVAILABLE", "GitHub App authentication unavailable");
  }
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = Math.floor(now.getTime() / 1000) + 540;
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iat: issuedAt, exp: expiresAt, iss: appId })}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  } catch {
    return fail("APP_JWT_UNAVAILABLE", "GitHub App authentication unavailable");
  }
}

function githubHeaders(binding: RestrictedCicdGithubBinding, token: string, accept = "application/vnd.github+json") {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agentnovas-restricted-cicd-worker/1",
    "x-github-api-version": binding.apiVersion,
  };
}

function requestSignal(timeoutMs: number) {
  return AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), 15_000));
}

async function boundedText(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > maximum) throw new Error("response too large");
  return text;
}

async function boundedBytes(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("response too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("response too large");
  return bytes;
}

async function githubJson(input: {
  binding: RestrictedCicdGithubBinding;
  token: string;
  fetchImpl: FetchLike;
  pathname: string;
  method?: "GET" | "POST";
  body?: unknown;
  expectedStatus?: number;
  timeoutMs?: number;
}) {
  const url = new URL(input.pathname, input.binding.apiBaseUrl);
  if (url.origin !== GITHUB_API_BASE_URL || !url.pathname.startsWith("/")) throw new Error("invalid endpoint");
  const response = await input.fetchImpl(url, {
    method: input.method ?? "GET",
    headers: githubHeaders(input.binding, input.token),
    redirect: "error",
    signal: requestSignal(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  if (response.status !== (input.expectedStatus ?? 200)) throw new Error("unexpected provider status");
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "application/vnd.github+json") {
    throw new Error("unexpected provider media type");
  }
  const text = await boundedText(response, MAX_JSON_BYTES);
  return JSON.parse(text) as unknown;
}

function permissionsExact(value: unknown) {
  if (!isObject(value)
    || value.actions !== EXACT_APP_PERMISSIONS.actions
    || value.contents !== EXACT_APP_PERMISSIONS.contents) return false;
  const keys = Object.keys(value).sort();
  return (keys.length === 2 && keys[0] === "actions" && keys[1] === "contents")
    || (keys.length === 3
      && keys[0] === "actions"
      && keys[1] === "contents"
      && keys[2] === "metadata"
      && value.metadata === "read");
}

function numberMatches(value: unknown, expected: string) {
  return (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected)
    || (typeof value === "string" && value === expected);
}

function assertAppBinding(value: unknown, binding: RestrictedCicdGithubBinding) {
  if (!isObject(value)
    || !numberMatches(value.id, binding.appId)
    || !isObject(value.owner)
    || !numberMatches(value.owner.id, binding.accountId)
    || value.owner.login !== binding.repositoryOwner
    || !permissionsExact(value.permissions)) {
    return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
  }
}

function assertInstallationBinding(value: unknown, binding: RestrictedCicdGithubBinding) {
  if (!isObject(value)
    || !numberMatches(value.id, binding.installationId)
    || !numberMatches(value.app_id, binding.appId)
    || value.repository_selection !== "selected"
    || value.suspended_at !== null
    || !isObject(value.account)
    || !numberMatches(value.account.id, binding.accountId)
    || value.account.login !== binding.repositoryOwner
    || !permissionsExact(value.permissions)) {
    return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
  }
}

async function listAllInstallations(
  binding: RestrictedCicdGithubBinding,
  appJwt: string,
  fetchImpl: FetchLike,
) {
  const installations: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const value = await githubJson({
      binding,
      token: appJwt,
      fetchImpl,
      pathname: `/app/installations?per_page=100&page=${page}`,
    });
    if (!Array.isArray(value)) throw new Error("installation response invalid");
    installations.push(...value);
    if (value.length < 100) return installations;
  }
  return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
}

function validateMintedToken(value: unknown, binding: RestrictedCicdGithubBinding, now: Date) {
  if (!isObject(value)
    || typeof value.token !== "string"
    || value.token.length < 1
    || value.token.length > 8_192
    || typeof value.expires_at !== "string"
    || !permissionsExact(value.permissions)
    || value.repository_selection !== "selected"
    || !Array.isArray(value.repositories)
    || value.repositories.length !== 1
    || !isObject(value.repositories[0])
    || !numberMatches(value.repositories[0].id, binding.repositoryId)
    || value.repositories[0].full_name !== `${binding.repositoryOwner}/${binding.repositoryName}`) {
    return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
  }
  const expiry = new Date(value.expires_at);
  const remaining = expiry.getTime() - now.getTime();
  if (!Number.isFinite(expiry.getTime()) || remaining < 60_000 || remaining > 60 * 60_000) {
    return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
  }
  return value.token;
}

export async function withRestrictedCicdInstallationToken<T>(
  binding: RestrictedCicdGithubBinding,
  privateKey: KeyObject,
  dependencies: { fetchImpl?: FetchLike; now?: Date; timeoutMs?: number },
  callback: (token: string) => Promise<T>,
): Promise<T> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? new Date();
  const appJwt = createGithubAppJwt(privateKey, binding.appId, now);
  let installationToken: string;
  try {
    const app = await githubJson({ binding, token: appJwt, fetchImpl, pathname: "/app", timeoutMs: dependencies.timeoutMs });
    assertAppBinding(app, binding);
    const installations = await listAllInstallations(binding, appJwt, fetchImpl);
    if (installations.length !== 1) return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    assertInstallationBinding(installations[0], binding);
    const tokenResponse = await githubJson({
      binding,
      token: appJwt,
      fetchImpl,
      pathname: `/app/installations/${binding.installationId}/access_tokens`,
      method: "POST",
      expectedStatus: 201,
      timeoutMs: dependencies.timeoutMs,
      body: {
        repository_ids: [Number(binding.repositoryId)],
        permissions: EXACT_APP_PERMISSIONS,
      },
    });
    installationToken = validateMintedToken(tokenResponse, binding, now);
  } catch (error) {
    if (error instanceof RestrictedCicdGithubError) throw error;
    return fail("PROVIDER_UNAVAILABLE", "GitHub provider verification unavailable");
  }
  return callback(installationToken);
}

function repoPrefix(binding: RestrictedCicdGithubBinding) {
  return `/repos/${encodeURIComponent(binding.repositoryOwner)}/${encodeURIComponent(binding.repositoryName)}`;
}

async function githubRaw(input: {
  binding: RestrictedCicdGithubBinding;
  token: string;
  fetchImpl: FetchLike;
  pathname: string;
  timeoutMs?: number;
}) {
  const url = new URL(input.pathname, input.binding.apiBaseUrl);
  if (url.origin !== GITHUB_API_BASE_URL) throw new Error("invalid endpoint");
  const response = await input.fetchImpl(url, {
    method: "GET",
    headers: githubHeaders(input.binding, input.token, "application/vnd.github.raw+json"),
    redirect: "error",
    signal: requestSignal(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error("unexpected provider status");
  return boundedBytes(response, MAX_WORKFLOW_BYTES);
}

export async function verifyRestrictedCicdProviderBinding(
  binding: RestrictedCicdGithubBinding,
  installationToken: string,
  dependencies: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const tagName = binding.workflowControlRef.slice("refs/tags/".length);
    const encodedTag = tagName.split("/").map(encodeURIComponent).join("/");
    const reference = await githubJson({
      binding,
      token: installationToken,
      fetchImpl,
      pathname: `${repoPrefix(binding)}/git/ref/tags/${encodedTag}`,
      timeoutMs: dependencies.timeoutMs,
    });
    if (!isObject(reference)
      || reference.ref !== binding.workflowControlRef
      || !isObject(reference.object)
      || !commitSha(reference.object.sha)
      || (reference.object.type !== "commit" && reference.object.type !== "tag")) {
      return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    }
    let resolvedCommit = reference.object.sha;
    if (reference.object.type === "tag") {
      const tag = await githubJson({
        binding,
        token: installationToken,
        fetchImpl,
        pathname: `${repoPrefix(binding)}/git/tags/${reference.object.sha}`,
        timeoutMs: dependencies.timeoutMs,
      });
      if (!isObject(tag)
        || tag.sha !== reference.object.sha
        || !isObject(tag.object)
        || tag.object.type !== "commit"
        || !commitSha(tag.object.sha)) {
        return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
      }
      resolvedCommit = tag.object.sha;
    }
    if (resolvedCommit !== binding.controlCommitSha) {
      return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    }
    const workflow = await githubJson({
      binding,
      token: installationToken,
      fetchImpl,
      pathname: `${repoPrefix(binding)}/actions/workflows/${binding.workflowId}`,
      timeoutMs: dependencies.timeoutMs,
    });
    if (!isObject(workflow)
      || !numberMatches(workflow.id, binding.workflowId)
      || workflow.path !== binding.workflowPath
      || workflow.state !== "active") {
      return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    }
    const encodedWorkflowPath = binding.workflowPath.split("/").map(encodeURIComponent).join("/");
    const rawWorkflow = await githubRaw({
      binding,
      token: installationToken,
      fetchImpl,
      pathname: `${repoPrefix(binding)}/contents/${encodedWorkflowPath}?ref=${binding.controlCommitSha}`,
      timeoutMs: dependencies.timeoutMs,
    });
    const digest = createHash("sha256").update(rawWorkflow).digest("hex");
    if (digest !== binding.workflowSha256) {
      return fail("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    }
    return { controlCommitSha: resolvedCommit, workflowSha256: digest };
  } catch (error) {
    if (error instanceof RestrictedCicdGithubError) throw error;
    return fail("PROVIDER_UNAVAILABLE", "GitHub provider verification unavailable");
  }
}

export type RestrictedCicdDispatchSnapshot = {
  commandId: string;
  releaseVersionId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  artifactManifestSha256: string;
  environmentGeneration: number;
};

export type PreparedRestrictedCicdDispatch = {
  requestBody: string;
  dispatchRequestSha256: string;
};

export function prepareRestrictedCicdDispatch(
  binding: RestrictedCicdGithubBinding,
  snapshot: RestrictedCicdDispatchSnapshot,
): PreparedRestrictedCicdDispatch {
  if (snapshot.environment !== binding.environment) {
    return fail("ENVIRONMENT_MISMATCH", "GitHub workflow dispatch environment mismatch");
  }
  const envelope = buildReleaseWorkflowDispatchEnvelope({
    workflowControlRef: binding.workflowControlRef,
    ...snapshot,
  });
  const requestBody = JSON.stringify(envelope);
  return {
    requestBody,
    dispatchRequestSha256: createHash("sha256").update(requestBody).digest("hex"),
  };
}

export async function dispatchPreparedRestrictedCicdWorkflow(
  binding: RestrictedCicdGithubBinding,
  installationToken: string,
  prepared: PreparedRestrictedCicdDispatch,
  dependencies: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
) {
  if (createHash("sha256").update(prepared.requestBody).digest("hex") !== prepared.dispatchRequestSha256) {
    return fail("DISPATCH_REQUEST_INVALID", "GitHub workflow dispatch request invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(prepared.requestBody);
  } catch {
    return fail("DISPATCH_REQUEST_INVALID", "GitHub workflow dispatch request invalid");
  }
  if (!isObject(parsed)
    || !hasExactKeys(parsed, ["ref", "inputs"])
    || parsed.ref !== binding.workflowControlRef
    || !isObject(parsed.inputs)
    || !hasExactKeys(parsed.inputs, [
      "schema_version", "command_id", "release_version_id", "environment", "action",
      "artifact_manifest_sha256", "environment_generation",
    ])
    || parsed.inputs.schema_version !== "2"
    || typeof parsed.inputs.command_id !== "string"
    || typeof parsed.inputs.release_version_id !== "string"
    || parsed.inputs.environment !== binding.environment
    || (parsed.inputs.action !== "deploy" && parsed.inputs.action !== "rollback")
    || typeof parsed.inputs.artifact_manifest_sha256 !== "string"
    || typeof parsed.inputs.environment_generation !== "string"
    || !/^[1-9][0-9]{0,15}$/.test(parsed.inputs.environment_generation)) {
    return fail("DISPATCH_REQUEST_INVALID", "GitHub workflow dispatch request invalid");
  }
  let canonical: PreparedRestrictedCicdDispatch;
  try {
    canonical = prepareRestrictedCicdDispatch(binding, {
      commandId: parsed.inputs.command_id,
      releaseVersionId: parsed.inputs.release_version_id,
      environment: binding.environment,
      action: parsed.inputs.action,
      artifactManifestSha256: parsed.inputs.artifact_manifest_sha256,
      environmentGeneration: Number(parsed.inputs.environment_generation),
    });
  } catch {
    return fail("DISPATCH_REQUEST_INVALID", "GitHub workflow dispatch request invalid");
  }
  if (canonical.requestBody !== prepared.requestBody
    || canonical.dispatchRequestSha256 !== prepared.dispatchRequestSha256) {
    return fail("DISPATCH_REQUEST_INVALID", "GitHub workflow dispatch request invalid");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      new URL(`${repoPrefix(binding)}/actions/workflows/${binding.workflowId}/dispatches`, binding.apiBaseUrl),
      {
        method: "POST",
        headers: githubHeaders(binding, installationToken),
        redirect: "error",
        signal: requestSignal(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        body: prepared.requestBody,
      },
    );
    if (response.status !== 200) throw new Error("dispatch status");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json" && mediaType !== "application/vnd.github+json") throw new Error("dispatch type");
    const value = JSON.parse(await boundedText(response, MAX_JSON_BYTES)) as unknown;
    if (!isObject(value)
      || typeof value.workflow_run_id !== "number"
      || !Number.isSafeInteger(value.workflow_run_id)
      || value.workflow_run_id < 1) {
      throw new Error("dispatch body");
    }
    const providerRunId = String(value.workflow_run_id);
    const expectedApiUrl = `${GITHUB_API_BASE_URL}${repoPrefix(binding)}/actions/runs/${providerRunId}`;
    const expectedHtmlUrl = `https://github.com/${binding.repositoryOwner}/${binding.repositoryName}/actions/runs/${providerRunId}`;
    if (value.run_url !== expectedApiUrl || value.html_url !== expectedHtmlUrl) throw new Error("dispatch urls");
    return {
      providerRunId,
      providerRunUrl: expectedHtmlUrl,
      dispatchRequestSha256: prepared.dispatchRequestSha256,
    };
  } catch {
    return fail("DISPATCH_OUTCOME_UNKNOWN", "GitHub workflow dispatch outcome unknown");
  }
}

export async function dispatchRestrictedCicdWorkflow(
  binding: RestrictedCicdGithubBinding,
  installationToken: string,
  snapshot: RestrictedCicdDispatchSnapshot,
  dependencies: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
) {
  return dispatchPreparedRestrictedCicdWorkflow(
    binding,
    installationToken,
    prepareRestrictedCicdDispatch(binding, snapshot),
    dependencies,
  );
}

export async function cancelRestrictedCicdWorkflowRun(
  binding: RestrictedCicdGithubBinding,
  installationToken: string,
  providerRunId: string,
  dependencies: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
) {
  if (!positiveDecimal(providerRunId)) return fail("RUN_CANCEL_UNCONFIRMED", "GitHub run cancellation unconfirmed");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      new URL(`${repoPrefix(binding)}/actions/runs/${providerRunId}/cancel`, binding.apiBaseUrl),
      {
        method: "POST",
        headers: githubHeaders(binding, installationToken),
        redirect: "error",
        signal: requestSignal(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    if (response.status !== 202) throw new Error("cancel status");
    return { providerRunId, cancellationRequested: true as const };
  } catch {
    return fail("RUN_CANCEL_UNCONFIRMED", "GitHub run cancellation unconfirmed");
  }
}

export async function verifyRestrictedCicdWorkflowRun(
  binding: RestrictedCicdGithubBinding,
  installationToken: string,
  providerRunId: string,
  dependencies: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
) {
  if (!positiveDecimal(providerRunId)) return fail("EXACT_RUN_MISMATCH", "GitHub exact run mismatch");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const value = await githubJson({
      binding,
      token: installationToken,
      fetchImpl,
      pathname: `${repoPrefix(binding)}/actions/runs/${providerRunId}`,
      timeoutMs: dependencies.timeoutMs,
    });
    const tagName = binding.workflowControlRef.slice("refs/tags/".length);
    const expectedPath = `${binding.workflowPath}@${tagName}`;
    const allowedStatuses = new Set(["queued", "in_progress", "completed", "requested", "waiting", "pending"]);
    const allowedConclusions = new Set([
      "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
      "startup_failure", "success", "timed_out",
    ]);
    const updatedAt = isObject(value) && typeof value.updated_at === "string"
      ? new Date(value.updated_at)
      : new Date(Number.NaN);
    if (!isObject(value)
      || !numberMatches(value.id, providerRunId)
      || value.run_attempt !== 1
      || value.event !== "workflow_dispatch"
      || value.head_sha !== binding.controlCommitSha
      || value.head_branch !== tagName
      || value.path !== expectedPath
      || !numberMatches(value.workflow_id, binding.workflowId)
      || typeof value.status !== "string"
      || !allowedStatuses.has(value.status)
      || (value.conclusion !== null
        && (typeof value.conclusion !== "string" || !allowedConclusions.has(value.conclusion)))
      || !Number.isFinite(updatedAt.getTime())
      || !isObject(value.repository)
      || !numberMatches(value.repository.id, binding.repositoryId)
      || value.repository.full_name !== `${binding.repositoryOwner}/${binding.repositoryName}`) {
      return fail("EXACT_RUN_MISMATCH", "GitHub exact run mismatch");
    }
    return {
      providerRunId,
      runAttempt: 1 as const,
      headSha: binding.controlCommitSha,
      status: value.status,
      conclusion: value.conclusion as string | null,
      updatedAt: updatedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof RestrictedCicdGithubError) throw error;
    return fail("PROVIDER_UNAVAILABLE", "GitHub exact run verification unavailable");
  }
}
