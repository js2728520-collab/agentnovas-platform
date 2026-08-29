import {
  createHash,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

type JsonObject = Record<string, unknown>;
type QueryResult = { rows: Array<Record<string, unknown>> };
type Queryable = { query: (text: string, values?: unknown[]) => Promise<QueryResult> };
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const API_BASE_URL = "https://api.github.com";
const API_VERSION = "2026-03-10";
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class RestrictedCicdAuditorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdAuditorError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdAuditorError(code, message);
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: JsonObject, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_ID.test(value)
    && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;
}

function repoPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function deploymentPolicyName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/u.test(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return fail("AUDITOR_EVIDENCE_INVALID", "Restricted CI/CD auditor evidence invalid");
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function numericIdentity(value: unknown) {
  if ((typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    && (typeof value !== "string" || !decimal(value))) return fail("PROVIDER_POLICY_DRIFT", "Provider identity drift detected");
  return String(value);
}

function normalizedActor(value: unknown) {
  if (!object(value) || !repoPart(value.login) || value.type !== "User") {
    return fail("PROVIDER_POLICY_DRIFT", "Provider actor drift detected");
  }
  return { id: numericIdentity(value.id), login: value.login, type: "User" as const };
}

function normalizeEnvironment(value: unknown) {
  if (!object(value) || !repoPart(value.name) || !Array.isArray(value.protection_rules)
    || !object(value.deployment_branch_policy)) {
    return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
  }
  const rules = value.protection_rules.map((item) => {
    if (!object(item) || typeof item.type !== "string") return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
    if (item.type === "wait_timer") {
      if (!Number.isSafeInteger(item.wait_timer) || Number(item.wait_timer) < 0) return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
      return { type: "wait_timer", waitTimer: item.wait_timer };
    }
    if (item.type === "required_reviewers") {
      if (typeof item.prevent_self_review !== "boolean" || !Array.isArray(item.reviewers)) return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
      const reviewers = item.reviewers.map((entry) => {
        if (!object(entry) || entry.type !== "User" || !object(entry.reviewer)) return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
        return normalizedActor(entry.reviewer);
      }).sort((left, right) => left.id.localeCompare(right.id));
      return { type: "required_reviewers", preventSelfReview: item.prevent_self_review, reviewers };
    }
    return fail("PROVIDER_POLICY_DRIFT", "Provider environment rule drift detected");
  }).sort((left, right) => left.type.localeCompare(right.type));
  const branchPolicy = value.deployment_branch_policy;
  if (typeof branchPolicy.protected_branches !== "boolean" || typeof branchPolicy.custom_branch_policies !== "boolean") {
    return fail("PROVIDER_POLICY_DRIFT", "Provider environment drift detected");
  }
  return {
    id: numericIdentity(value.id), name: value.name,
    protectionRules: rules,
    deploymentBranchPolicy: {
      protectedBranches: branchPolicy.protected_branches,
      customBranchPolicies: branchPolicy.custom_branch_policies,
    },
  };
}

function normalizeRuleset(value: unknown) {
  if (!object(value) || !repoPart(value.name) || value.target !== "tag" || value.enforcement !== "active"
    || !Array.isArray(value.bypass_actors) || !object(value.conditions) || !Array.isArray(value.rules)) {
    return fail("PROVIDER_POLICY_DRIFT", "Provider ruleset drift detected");
  }
  return {
    id: numericIdentity(value.id), name: value.name, target: value.target, enforcement: value.enforcement,
    bypassActors: value.bypass_actors,
    conditions: value.conditions,
    rules: value.rules,
  };
}

function normalizeDeploymentBranchPolicies(value: unknown) {
  if (!object(value) || !Number.isSafeInteger(value.total_count) || Number(value.total_count) < 1
    || !Array.isArray(value.branch_policies) || value.branch_policies.length !== value.total_count
    || value.branch_policies.length > 100) {
    return fail("PROVIDER_POLICY_DRIFT", "Provider deployment branch policy drift detected");
  }
  return value.branch_policies.map((item) => {
    if (!object(item) || !deploymentPolicyName(item.name)) {
      return fail("PROVIDER_POLICY_DRIFT", "Provider deployment branch policy drift detected");
    }
    return { id: numericIdentity(item.id), name: item.name };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRunner(job: unknown, runnerEnvironment: "github-hosted" | "self-hosted") {
  if (!object(job) || !Array.isArray(job.labels)
    || job.labels.some((label) => typeof label !== "string" || label.length < 1 || label.length > 100)
    || !Number.isSafeInteger(job.runner_id) || !Number.isSafeInteger(job.runner_group_id)) {
    return fail("PROVIDER_POLICY_DRIFT", "Provider runner drift detected");
  }
  return {
    runnerEnvironment,
    labels: [...job.labels].sort(),
    runnerId: runnerEnvironment === "github-hosted" ? 0 : job.runner_id,
    runnerGroupId: job.runner_group_id,
    runnerGroupName: typeof job.runner_group_name === "string" ? job.runner_group_name : "",
  };
}

export function computeRestrictedCicdEnvironmentPolicySha256(
  environment: unknown,
  ruleset: unknown,
  deploymentBranchPolicies: unknown,
) {
  return digest({
    environment: normalizeEnvironment(environment),
    ruleset: normalizeRuleset(ruleset),
    deploymentBranchPolicies: normalizeDeploymentBranchPolicies(deploymentBranchPolicies),
  });
}

export function computeRestrictedCicdRunnerPolicySha256(job: unknown, runnerEnvironment: "github-hosted" | "self-hosted") {
  return digest(normalizeRunner(job, runnerEnvironment));
}

export type RestrictedCicdAuditorPolicy = {
  schemaVersion: "1";
  provider: "github_actions";
  apiVersion: "2026-03-10";
  apiBaseUrl: "https://api.github.com";
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string;
  accountId: string;
  appId: string;
  installationId: string;
  workflowId: string;
  controlCommitSha: string;
  environment: "staging" | "production";
  environmentId: string;
  rulesetId: string;
  deploymentBranchPolicyId: string;
  deploymentBranchPolicyName: string;
  runnerEnvironment: "github-hosted" | "self-hosted";
  reviewerAllowlist: Array<{ id: string; type: "User" }>;
  environmentPolicySha256: string;
  runnerPolicySha256: string;
  attestationKeyId: string;
};

const POLICY_KEYS = [
  "schemaVersion", "provider", "apiVersion", "apiBaseUrl", "repositoryOwner", "repositoryName",
  "repositoryId", "accountId", "appId", "installationId", "workflowId", "controlCommitSha",
  "environment", "environmentId", "rulesetId", "deploymentBranchPolicyId",
  "deploymentBranchPolicyName", "runnerEnvironment", "reviewerAllowlist",
  "environmentPolicySha256", "runnerPolicySha256", "attestationKeyId",
] as const;

export function parseRestrictedCicdAuditorPolicy(input: unknown): RestrictedCicdAuditorPolicy {
  if (!object(input) || !exact(input, POLICY_KEYS)
    || input.schemaVersion !== "1" || input.provider !== "github_actions"
    || input.apiVersion !== API_VERSION || input.apiBaseUrl !== API_BASE_URL
    || !repoPart(input.repositoryOwner) || !repoPart(input.repositoryName)
    || !decimal(input.repositoryId) || !decimal(input.accountId) || !decimal(input.appId)
    || !decimal(input.installationId) || !decimal(input.workflowId) || !COMMIT_SHA.test(String(input.controlCommitSha))
    || (input.environment !== "staging" && input.environment !== "production")
    || !decimal(input.environmentId) || !decimal(input.rulesetId) || !decimal(input.deploymentBranchPolicyId)
    || !deploymentPolicyName(input.deploymentBranchPolicyName)
    || (input.runnerEnvironment !== "github-hosted" && input.runnerEnvironment !== "self-hosted")
    || !Array.isArray(input.reviewerAllowlist) || input.reviewerAllowlist.length < 1 || input.reviewerAllowlist.length > 50
    || !SHA256.test(String(input.environmentPolicySha256)) || !SHA256.test(String(input.runnerPolicySha256))
    || !IDENTIFIER.test(String(input.attestationKeyId))) {
    return fail("AUDITOR_POLICY_INVALID", "Restricted CI/CD auditor policy invalid");
  }
  const reviewers = input.reviewerAllowlist as unknown[];
  if (reviewers.some((reviewer) => !object(reviewer) || !exact(reviewer, ["id", "type"])
    || !decimal(reviewer.id) || reviewer.type !== "User")
    || new Set(reviewers.map((reviewer) => (reviewer as JsonObject).id)).size !== reviewers.length) {
    return fail("AUDITOR_POLICY_INVALID", "Restricted CI/CD auditor policy invalid");
  }
  return input as RestrictedCicdAuditorPolicy;
}

export type RestrictedCicdAuditorRequest = {
  schemaVersion: "1";
  providerRunId: string;
  jobId: string;
  environment: "staging" | "production";
  oidcJtiSha256: string;
  oidcClaimsSha256: string;
  oidcIssuedAt: string;
  oidcExpiresAt: string;
};

const REQUEST_KEYS = [
  "schemaVersion", "providerRunId", "jobId", "environment", "oidcJtiSha256",
  "oidcClaimsSha256", "oidcIssuedAt", "oidcExpiresAt",
] as const;

function exactTimestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function githubTimestamp(value: unknown) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    && Number.isFinite(new Date(value).getTime());
}

export function parseRestrictedCicdAuditorRequest(input: unknown): RestrictedCicdAuditorRequest {
  if (!object(input) || !exact(input, REQUEST_KEYS) || input.schemaVersion !== "1"
    || !decimal(input.providerRunId) || !decimal(input.jobId)
    || (input.environment !== "staging" && input.environment !== "production")
    || !SHA256.test(String(input.oidcJtiSha256)) || !SHA256.test(String(input.oidcClaimsSha256))
    || !exactTimestamp(input.oidcIssuedAt) || !exactTimestamp(input.oidcExpiresAt)) {
    return fail("AUDITOR_REQUEST_INVALID", "Restricted CI/CD auditor request invalid");
  }
  const issued = new Date(input.oidcIssuedAt as string).getTime();
  const expires = new Date(input.oidcExpiresAt as string).getTime();
  if (expires <= issued || expires - issued > 10 * 60_000) return fail("AUDITOR_REQUEST_INVALID", "Restricted CI/CD auditor request invalid");
  return input as RestrictedCicdAuditorRequest;
}

function verifyPolicyFixtureMaterial(
  policy: RestrictedCicdAuditorPolicy,
  environment: unknown,
  ruleset: unknown,
  deploymentBranchPolicies: unknown,
) {
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedRuleset = normalizeRuleset(ruleset);
  const normalizedDeploymentBranchPolicies = normalizeDeploymentBranchPolicies(deploymentBranchPolicies);
  const requiredReviewerRule = normalizedEnvironment.protectionRules.find((rule) => rule.type === "required_reviewers");
  const configuredReviewers = requiredReviewerRule?.type === "required_reviewers" && requiredReviewerRule.reviewers
    ? requiredReviewerRule.reviewers.map((reviewer) => `User:${reviewer.id}`).sort() : [];
  const frozenReviewers = policy.reviewerAllowlist.map((reviewer) => `${reviewer.type}:${reviewer.id}`).sort();
  const environmentPolicySha256 = computeRestrictedCicdEnvironmentPolicySha256(
    environment, ruleset, deploymentBranchPolicies,
  );
  if (environmentPolicySha256 !== policy.environmentPolicySha256
    || normalizedEnvironment.id !== policy.environmentId || normalizedEnvironment.name !== policy.environment
    || normalizedRuleset.id !== policy.rulesetId
    || normalizedEnvironment.deploymentBranchPolicy.protectedBranches !== false
    || normalizedEnvironment.deploymentBranchPolicy.customBranchPolicies !== true
    || normalizedDeploymentBranchPolicies.length !== 1
    || normalizedDeploymentBranchPolicies[0].id !== policy.deploymentBranchPolicyId
    || normalizedDeploymentBranchPolicies[0].name !== policy.deploymentBranchPolicyName
    || requiredReviewerRule?.type !== "required_reviewers" || requiredReviewerRule.preventSelfReview !== true
    || configuredReviewers.join("|") !== frozenReviewers.join("|")
    || normalizedRuleset.bypassActors.length !== 0) {
    return fail("PROVIDER_POLICY_DRIFT", "Provider environment policy drift detected");
  }
  return {
    environment: policy.environment,
    environmentId: policy.environmentId,
    rulesetId: policy.rulesetId,
    deploymentBranchPolicyId: policy.deploymentBranchPolicyId,
    environmentPolicySha256,
  };
}

export async function verifyRestrictedCicdAuditorPolicyFixture(input: {
  policy: RestrictedCicdAuditorPolicy;
  installationToken: string;
  fetchImpl?: FetchLike;
}) {
  const policy = parseRestrictedCicdAuditorPolicy(input.policy);
  if (typeof input.installationToken !== "string" || input.installationToken.length < 1
    || input.installationToken.length > 8192) {
    return fail("AUDITOR_REQUEST_INVALID", "Restricted CI/CD auditor fixture request invalid");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const prefix = `/repos/${encodeURIComponent(policy.repositoryOwner)}/${encodeURIComponent(policy.repositoryName)}`;
  const [environment, ruleset, deploymentBranchPolicies] = await Promise.all([
    githubGet(policy, input.installationToken,
      `${prefix}/environments/${encodeURIComponent(policy.environment)}`, fetchImpl),
    githubGet(policy, input.installationToken, `${prefix}/rulesets/${policy.rulesetId}`, fetchImpl),
    githubGet(policy, input.installationToken,
      `${prefix}/environments/${encodeURIComponent(policy.environment)}/deployment-branch-policies?per_page=100`, fetchImpl),
  ]);
  return verifyPolicyFixtureMaterial(policy, environment, ruleset, deploymentBranchPolicies);
}

async function githubGet(policy: RestrictedCicdAuditorPolicy, token: string, pathname: string, fetchImpl: FetchLike) {
  const url = new URL(pathname, policy.apiBaseUrl);
  if (url.origin !== API_BASE_URL || url.username || url.password || url.hash) return fail("PROVIDER_ENDPOINT_REJECTED", "Provider endpoint rejected");
  const response = await fetchImpl(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      "user-agent": "agentnovas-release-provider-security-auditor/1",
      "x-github-api-version": policy.apiVersion,
    },
  });
  if (response.status !== 200) return fail("PROVIDER_UNAVAILABLE", "Provider policy verification unavailable");
  const media = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (media !== "application/json" && media !== "application/vnd.github+json") return fail("PROVIDER_UNAVAILABLE", "Provider policy verification unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return fail("PROVIDER_UNAVAILABLE", "Provider policy verification unavailable");
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return fail("PROVIDER_UNAVAILABLE", "Provider policy verification unavailable");
  try { return JSON.parse(body) as unknown; } catch { return fail("PROVIDER_UNAVAILABLE", "Provider policy verification unavailable"); }
}

export type RestrictedCicdAuditorAttestation = {
  schemaVersion: "1";
  kind: "provider_policy_observed";
  repositoryId: string;
  workflowId: string;
  runId: string;
  runAttempt: 1;
  jobId: string;
  environment: "staging" | "production";
  environmentId: string;
  environmentDecision: "provider_policy_observed";
  review: { decision: "approved"; reviewerId: string; reviewerType: "User"; submittedAt: string };
  triggeringActorId: string;
  runner: ReturnType<typeof normalizeRunner>;
  environmentPolicySha256: string;
  runnerPolicySha256: string;
  reviewEvidenceSha256: string;
  oidcJtiSha256: string;
  oidcClaimsSha256: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
};

export function verifyRestrictedCicdAuditorAttestation(attestation: RestrictedCicdAuditorAttestation, signature: string, publicKey: KeyObject) {
  try { return verify(null, Buffer.from(canonicalize(attestation)), publicKey, Buffer.from(signature, "base64url")); } catch { return false; }
}

export function createRestrictedCicdAuditorDatabase(queryable: Queryable) {
  return {
    async append(attestationId: string, attestation: RestrictedCicdAuditorAttestation, signature: string) {
      const result = await queryable.query(`SELECT * FROM release_workflow_append_run_policy_attestation(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )`, [
        attestationId, attestation.repositoryId, attestation.workflowId, attestation.runId,
        attestation.runAttempt, attestation.jobId, attestation.environment,
        attestation.environmentPolicySha256, attestation.runnerPolicySha256,
        attestation.reviewEvidenceSha256, attestation.oidcJtiSha256, attestation.nonce,
        attestation.keyId, signature, new Date(attestation.expiresAt),
      ]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row.attestation_id !== attestationId || typeof row.replayed !== "boolean") {
        throw new Error("auditor database gateway response invalid");
      }
      return { attestationId, replayed: row.replayed as boolean };
    },
  };
}

export async function auditRestrictedCicdGithubRun(input: {
  policy: RestrictedCicdAuditorPolicy;
  request: RestrictedCicdAuditorRequest;
  installationToken: string;
  attestationPrivateKey: KeyObject;
  database: ReturnType<typeof createRestrictedCicdAuditorDatabase>;
  fetchImpl?: FetchLike;
  now?: Date;
}) {
  const policy = parseRestrictedCicdAuditorPolicy(input.policy);
  const request = parseRestrictedCicdAuditorRequest(input.request);
  const now = input.now ?? new Date();
  if (request.environment !== policy.environment || input.attestationPrivateKey.asymmetricKeyType !== "ed25519"
    || typeof input.installationToken !== "string" || input.installationToken.length < 1 || input.installationToken.length > 8192
    || now.getTime() < new Date(request.oidcIssuedAt).getTime() - 30_000
    || now.getTime() >= new Date(request.oidcExpiresAt).getTime()) {
    return fail("AUDITOR_REQUEST_INVALID", "Restricted CI/CD auditor request invalid");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const prefix = `/repos/${encodeURIComponent(policy.repositoryOwner)}/${encodeURIComponent(policy.repositoryName)}`;
  const [run, environment, ruleset, deploymentBranchPolicies, approvals, jobs] = await Promise.all([
    githubGet(policy, input.installationToken, `${prefix}/actions/runs/${request.providerRunId}`, fetchImpl),
    githubGet(policy, input.installationToken, `${prefix}/environments/${encodeURIComponent(policy.environment)}`, fetchImpl),
    githubGet(policy, input.installationToken, `${prefix}/rulesets/${policy.rulesetId}`, fetchImpl),
    githubGet(policy, input.installationToken,
      `${prefix}/environments/${encodeURIComponent(policy.environment)}/deployment-branch-policies?per_page=100`, fetchImpl),
    githubGet(policy, input.installationToken, `${prefix}/actions/runs/${request.providerRunId}/approvals`, fetchImpl),
    githubGet(policy, input.installationToken, `${prefix}/actions/runs/${request.providerRunId}/attempts/1/jobs?per_page=100`, fetchImpl),
  ]);
  if (!object(run) || numericIdentity(run.id) !== request.providerRunId || run.run_attempt !== 1
    || run.event !== "workflow_dispatch" || run.head_sha !== policy.controlCommitSha
    || numericIdentity(run.workflow_id) !== policy.workflowId
    || (run.status !== "queued" && run.status !== "in_progress") || run.conclusion !== null) {
    return fail("PROVIDER_RUN_MISMATCH", "Provider run mismatch detected");
  }
  const triggeringActor = normalizedActor(run.triggering_actor);
  verifyPolicyFixtureMaterial(policy, environment, ruleset, deploymentBranchPolicies);
  if (!object(jobs) || !Array.isArray(jobs.jobs)) return fail("PROVIDER_JOB_MISMATCH", "Provider job mismatch detected");
  const matchingJobs = jobs.jobs.filter((candidate) => object(candidate) && numericIdentity(candidate.id) === request.jobId);
  if (matchingJobs.length !== 1) return fail("PROVIDER_JOB_MISMATCH", "Provider job mismatch detected");
  const job = matchingJobs[0] as JsonObject;
  if (numericIdentity(job.run_id) !== request.providerRunId || job.run_attempt !== 1
    || (job.status !== "queued" && job.status !== "in_progress") || job.conclusion !== null
    || (policy.runnerEnvironment === "self-hosted" && (Number(job.runner_id) < 1 || Number(job.runner_group_id) < 1))
    || computeRestrictedCicdRunnerPolicySha256(job, policy.runnerEnvironment) !== policy.runnerPolicySha256) {
    return fail("PROVIDER_RUNNER_DRIFT", "Provider runner policy drift detected");
  }
  if (!Array.isArray(approvals)) return fail("PROVIDER_REVIEW_MISMATCH", "Provider review history unavailable");
  const normalizedReviews = approvals.map((entry) => {
    if (!object(entry) || typeof entry.state !== "string" || !Array.isArray(entry.environments)
      || !githubTimestamp(entry.submitted_at)) return fail("PROVIDER_REVIEW_MISMATCH", "Provider review history mismatch detected");
    const reviewer = normalizedActor(entry.user);
    const environments = entry.environments.map((item) => {
      if (!object(item) || !repoPart(item.name)) return fail("PROVIDER_REVIEW_MISMATCH", "Provider review history mismatch detected");
      return { id: numericIdentity(item.id), name: item.name };
    }).sort((left, right) => left.id.localeCompare(right.id));
    return { state: entry.state.toLowerCase(), submittedAt: new Date(entry.submitted_at as string).toISOString(), reviewer, environments };
  });
  const relevant = normalizedReviews.filter((review) => review.environments.some((item) => item.id === policy.environmentId && item.name === policy.environment));
  if (relevant.some((review) => review.state === "rejected")) return fail("PROVIDER_REVIEW_REJECTED", "Provider environment review rejected");
  const allowlist = new Set(policy.reviewerAllowlist.map((reviewer) => `${reviewer.type}:${reviewer.id}`));
  const approved = relevant.filter((review) => review.state === "approved"
    && allowlist.has(`${review.reviewer.type}:${review.reviewer.id}`)
    && review.reviewer.id !== triggeringActor.id).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  if (approved.length < 1) return fail("PROVIDER_REVIEW_MISMATCH", "Provider environment review mismatch detected");
  const selected = approved.at(-1)!;
  const issuedAt = request.oidcIssuedAt;
  const expiresAt = request.oidcExpiresAt;
  const stableIdentity = digest({ repositoryId: policy.repositoryId, workflowId: policy.workflowId,
    runId: request.providerRunId, jobId: request.jobId, oidcJtiSha256: request.oidcJtiSha256 });
  const attestation: RestrictedCicdAuditorAttestation = {
    schemaVersion: "1", kind: "provider_policy_observed", repositoryId: policy.repositoryId,
    workflowId: policy.workflowId, runId: request.providerRunId, runAttempt: 1, jobId: request.jobId,
    environment: policy.environment, environmentId: policy.environmentId,
    environmentDecision: "provider_policy_observed",
    review: { decision: "approved", reviewerId: selected.reviewer.id, reviewerType: "User", submittedAt: selected.submittedAt },
    triggeringActorId: triggeringActor.id, runner: normalizeRunner(job, policy.runnerEnvironment),
    environmentPolicySha256: policy.environmentPolicySha256, runnerPolicySha256: policy.runnerPolicySha256,
    reviewEvidenceSha256: digest(normalizedReviews), oidcJtiSha256: request.oidcJtiSha256,
    oidcClaimsSha256: request.oidcClaimsSha256, issuedAt, expiresAt,
    nonce: `auditor-v1-${stableIdentity.slice(0, 48)}`, keyId: policy.attestationKeyId,
  };
  const signature = sign(null, Buffer.from(canonicalize(attestation)), input.attestationPrivateKey).toString("base64url");
  const attestationId = `attestation-v1-${stableIdentity.slice(0, 48)}`;
  const appended = await input.database.append(attestationId, attestation, signature);
  return { ...appended, attestation, signature };
}

export async function auditRestrictedCicdTargetRun(input: {
  url: string;
  sharedSecret: string;
  request: RestrictedCicdAuditorRequest;
  fetchImpl?: FetchLike;
}) {
  const request = parseRestrictedCicdAuditorRequest(input.request);
  let url: URL;
  try { url = new URL(input.url); } catch { return fail("AUDITOR_ENDPOINT_INVALID", "Restricted CI/CD auditor endpoint invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/internal/restricted-cicd/audit"
    || url.search || url.hash || url.username || url.password
    || typeof input.sharedSecret !== "string" || input.sharedSecret.length < 32 || input.sharedSecret.length > 512) {
    return fail("AUDITOR_ENDPOINT_INVALID", "Restricted CI/CD auditor endpoint invalid");
  }
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${input.sharedSecret}` },
    body: JSON.stringify(request),
  });
  const body = await response.text();
  if (Buffer.byteLength(body) > 16 * 1024) return fail("AUDITOR_UNAVAILABLE", "Restricted CI/CD auditor unavailable");
  let value: unknown;
  try { value = JSON.parse(body); } catch { return fail("AUDITOR_UNAVAILABLE", "Restricted CI/CD auditor unavailable"); }
  if (response.status !== 200 || !object(value) || !exact(value, ["schemaVersion", "attestationId", "expiresAt", "replayed"])
    || value.schemaVersion !== "1" || !IDENTIFIER.test(String(value.attestationId))
    || !exactTimestamp(value.expiresAt) || typeof value.replayed !== "boolean") {
    return fail("AUDITOR_UNAVAILABLE", "Restricted CI/CD auditor unavailable");
  }
  return value as { schemaVersion: "1"; attestationId: string; expiresAt: string; replayed: boolean };
}
