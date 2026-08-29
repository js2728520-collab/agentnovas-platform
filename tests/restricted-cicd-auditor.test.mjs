import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  auditRestrictedCicdGithubRun,
  computeRestrictedCicdEnvironmentPolicySha256,
  computeRestrictedCicdRunnerPolicySha256,
  createRestrictedCicdAuditorDatabase,
  auditRestrictedCicdTargetRun,
  parseRestrictedCicdAuditorPolicy,
  parseRestrictedCicdAuditorRequest,
  verifyRestrictedCicdAuditorAttestation,
  verifyRestrictedCicdAuditorPolicyFixture,
} from "../lib/restricted-cicd-auditor.ts";

const now = new Date("2026-08-27T12:00:30.000Z");
const environmentResponse = {
  id: 41,
  name: "staging",
  protection_rules: [
    { type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 71, login: "release-reviewer", type: "User" } }], prevent_self_review: true },
    { type: "wait_timer", wait_timer: 0 },
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const rulesetResponse = {
  id: 51, name: "restricted-release-tags", target: "tag", enforcement: "active",
  bypass_actors: [], conditions: { ref_name: { include: ["refs/tags/release-*"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};
const deploymentBranchPoliciesResponse = {
  total_count: 1,
  branch_policies: [{ id: 61, node_id: "deployment-policy-node-61", name: "release-control-v1" }],
};
const job = {
  id: 301, run_id: 201, run_attempt: 1, status: "in_progress", conclusion: null,
  name: "deploy", labels: ["ubuntu-24.04", "github-hosted"], runner_id: 0,
  runner_name: "GitHub Actions 100", runner_group_id: 0, runner_group_name: "GitHub Actions",
};

function policy() {
  return parseRestrictedCicdAuditorPolicy({
    schemaVersion: "1", provider: "github_actions", apiVersion: "2026-03-10",
    apiBaseUrl: "https://api.github.com", repositoryOwner: "agentnovas", repositoryName: "platform",
    repositoryId: "101", accountId: "102", appId: "103", installationId: "104",
    workflowId: "105", controlCommitSha: "a".repeat(40), environment: "staging",
    environmentId: "41", rulesetId: "51", runnerEnvironment: "github-hosted",
    deploymentBranchPolicyId: "61", deploymentBranchPolicyName: "release-control-v1",
    reviewerAllowlist: [{ id: "71", type: "User" }],
    environmentPolicySha256: computeRestrictedCicdEnvironmentPolicySha256(
      environmentResponse, rulesetResponse, deploymentBranchPoliciesResponse,
    ),
    runnerPolicySha256: computeRestrictedCicdRunnerPolicySha256(job, "github-hosted"),
    attestationKeyId: "auditor-key-2026-08",
  });
}

function request() {
  return parseRestrictedCicdAuditorRequest({
    schemaVersion: "1", providerRunId: "201", jobId: "301", environment: "staging",
    oidcJtiSha256: "b".repeat(64), oidcClaimsSha256: "c".repeat(64),
    oidcIssuedAt: "2026-08-27T12:00:00.000Z", oidcExpiresAt: "2026-08-27T12:05:00.000Z",
  });
}

function providerFetch(overrides = {}) {
  const responses = {
    "/repos/agentnovas/platform/actions/runs/201": {
      id: 201, run_attempt: 1, event: "workflow_dispatch", head_sha: "a".repeat(40),
      workflow_id: 105, status: "in_progress", conclusion: null,
      triggering_actor: { id: 72, login: "release-operator", type: "User" },
    },
    "/repos/agentnovas/platform/environments/staging": environmentResponse,
    "/repos/agentnovas/platform/environments/staging/deployment-branch-policies?per_page=100": deploymentBranchPoliciesResponse,
    "/repos/agentnovas/platform/rulesets/51": rulesetResponse,
    "/repos/agentnovas/platform/actions/runs/201/approvals": [{
      state: "approved", submitted_at: "2026-08-27T12:00:20Z", comment: "approved",
      user: { id: 71, login: "release-reviewer", type: "User" },
      environments: [{ id: 41, name: "staging" }],
    }],
    "/repos/agentnovas/platform/actions/runs/201/attempts/1/jobs?per_page=100": { total_count: 1, jobs: [job] },
    ...overrides,
  };
  return async (input, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer read-only-token");
    const url = new URL(input);
    assert.ok(Object.hasOwn(responses, `${url.pathname}${url.search}`) || Object.hasOwn(responses, url.pathname));
    const body = responses[`${url.pathname}${url.search}`] ?? responses[url.pathname];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("auditor observes exact provider policy, signs deterministic evidence, and appends through one gateway", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const calls = [];
  const database = createRestrictedCicdAuditorDatabase({ query: async (text, values) => {
    calls.push({ text, values });
    return { rows: [{ attestation_id: values[0], replayed: false }] };
  } });
  const result = await auditRestrictedCicdGithubRun({
    policy: policy(), request: request(), installationToken: "read-only-token",
    attestationPrivateKey: privateKey, database, fetchImpl: providerFetch(), now,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /release_workflow_append_run_policy_attestation/);
  assert.equal(result.replayed, false);
  assert.equal(result.attestation.environmentDecision, "provider_policy_observed");
  assert.equal(result.attestation.review.reviewerId, "71");
  assert.equal(result.attestation.oidcJtiSha256, "b".repeat(64));
  assert.equal(result.attestation.expiresAt, "2026-08-27T12:05:00.000Z");
  assert.equal(verifyRestrictedCicdAuditorAttestation(result.attestation, result.signature, publicKey), true);
});

test("environment policy digest binds the exact custom deployment branch policy", () => {
  const expected = computeRestrictedCicdEnvironmentPolicySha256(
    environmentResponse, rulesetResponse, deploymentBranchPoliciesResponse,
  );
  const broadened = computeRestrictedCicdEnvironmentPolicySha256(
    environmentResponse, rulesetResponse,
    { ...deploymentBranchPoliciesResponse, branch_policies: [{ ...deploymentBranchPoliciesResponse.branch_policies[0], name: "release-control-v2" }] },
  );
  assert.notEqual(expected, broadened);
});

test("read-only fixture preflight verifies environment, ruleset, and exact deployment policy", async () => {
  const result = await verifyRestrictedCicdAuditorPolicyFixture({
    policy: policy(), installationToken: "read-only-token", fetchImpl: providerFetch(),
  });
  assert.deepEqual(result, {
    environment: "staging",
    environmentId: "41",
    rulesetId: "51",
    deploymentBranchPolicyId: "61",
    environmentPolicySha256: policy().environmentPolicySha256,
  });
});

test("auditor fails closed on rejected, self, unallowlisted, runner, environment, and run drift", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const database = createRestrictedCicdAuditorDatabase({ query: async () => { throw new Error("must not append"); } });
  const base = { policy: policy(), request: request(), installationToken: "read-only-token", attestationPrivateKey: privateKey, database, now };
  const cases = [
    { "/repos/agentnovas/platform/actions/runs/201/approvals": [{ state: "rejected", submitted_at: "2026-08-27T12:00:20.000Z", comment: "no", user: { id: 71, login: "release-reviewer", type: "User" }, environments: [{ id: 41, name: "staging" }] }] },
    { "/repos/agentnovas/platform/actions/runs/201": { id: 201, run_attempt: 1, event: "workflow_dispatch", head_sha: "a".repeat(40), workflow_id: 105, status: "in_progress", conclusion: null, triggering_actor: { id: 71, login: "release-reviewer", type: "User" } } },
    { "/repos/agentnovas/platform/actions/runs/201/approvals": [{ state: "approved", submitted_at: "2026-08-27T12:00:20.000Z", comment: "ok", user: { id: 999, login: "outsider", type: "User" }, environments: [{ id: 41, name: "staging" }] }] },
    { "/repos/agentnovas/platform/actions/runs/201/attempts/1/jobs?per_page=100": { total_count: 1, jobs: [{ ...job, labels: ["self-hosted"] }] } },
    { "/repos/agentnovas/platform/environments/staging": { ...environmentResponse, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } },
    { "/repos/agentnovas/platform/environments/staging/deployment-branch-policies?per_page=100": {
      total_count: 1, branch_policies: [{ id: 61, node_id: "deployment-policy-node-61", name: "*" }],
    } },
    { "/repos/agentnovas/platform/actions/runs/201": { id: 201, run_attempt: 2, event: "workflow_dispatch", head_sha: "a".repeat(40), workflow_id: 105, status: "in_progress", conclusion: null, triggering_actor: { id: 72, login: "release-operator", type: "User" } } },
  ];
  for (const overrides of cases) {
    await assert.rejects(auditRestrictedCicdGithubRun({ ...base, fetchImpl: providerFetch(overrides) }), /rejected|drift|mismatch|unavailable/i);
  }
});

test("auditor request and policy reject unknown fields and mutable provider endpoints", () => {
  assert.throws(() => parseRestrictedCicdAuditorRequest({ ...request(), extra: true }), /invalid/i);
  assert.throws(() => parseRestrictedCicdAuditorPolicy({ ...policy(), apiBaseUrl: "https://example.com" }), /invalid/i);
});

test("target auditor client accepts only loopback and one exact bounded response", async () => {
  const calls = [];
  const result = await auditRestrictedCicdTargetRun({
    url: "http://127.0.0.1:3316/internal/restricted-cicd/audit",
    sharedSecret: "s".repeat(48), request: request(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ schemaVersion: "1", attestationId: `attestation-v1-${"d".repeat(48)}`,
        expiresAt: "2026-08-27T12:05:00.000Z", replayed: false }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"s".repeat(48)}`);
  assert.equal(result.replayed, false);
  await assert.rejects(auditRestrictedCicdTargetRun({
    url: "https://auditor.example.com/internal/restricted-cicd/audit", sharedSecret: "s".repeat(48),
    request: request(), fetchImpl: async () => { throw new Error("must not call"); },
  }), /endpoint invalid/i);
});
