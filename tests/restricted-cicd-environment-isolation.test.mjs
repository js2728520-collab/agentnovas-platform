import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { computeRestrictedCicdProviderBindingSha256 } from "../lib/restricted-cicd-github.ts";
import { verifyRestrictedCicdInstanceConfig } from "../scripts/release/restricted-cicd-instance-config.mjs";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

function service(compose, name) {
  return compose.match(new RegExp(`\\n  ${name}:([\\s\\S]*?)(?=\\n  [a-z][a-z-]+:|\\nsecrets:)`))?.[1] ?? "";
}

test("restricted CI/CD deploys separate staging and production Worker/Auditor instances", async () => {
  const [compose, override, orchestratorUnit, auditorUnit] = await Promise.all([
    read("deploy/container/compose.yml"),
    read("deploy/container/restricted-cicd.override.yml"),
    read("deploy/systemd/agentnovas-release-orchestrator@.service"),
    read("deploy/systemd/agentnovas-release-provider-security-auditor@.service"),
  ]);

  for (const environment of ["staging", "production"]) {
    const worker = service(compose, `release-orchestrator-${environment}`);
    const auditor = service(compose, `release-provider-security-auditor-${environment}`);
    assert.notEqual(worker, "", `${environment} Worker service missing`);
    assert.notEqual(auditor, "", `${environment} Auditor service missing`);
    assert.match(worker, new RegExp(`release-orchestrator-${environment}\\.env`));
    assert.match(worker, new RegExp(`source: release_orchestrator_${environment}_binding`));
    assert.match(worker, new RegExp(`source: release_orchestrator_${environment}_app_key`));
    assert.match(auditor, new RegExp(`release-auditor-${environment}\\.env`));
    assert.match(auditor, new RegExp(`source: release_auditor_${environment}_policy`));
    assert.match(auditor, new RegExp(`source: release_auditor_${environment}_app_key`));
    assert.match(auditor, new RegExp(`source: release_auditor_${environment}_attestation_key`));
    assert.match(auditor, new RegExp(`source: release_auditor_${environment}_shared_secret`));
    assert.match(override, new RegExp(`release-orchestrator-${environment}:`));
    assert.match(override, new RegExp(`release-provider-security-auditor-${environment}:`));
  }

  assert.doesNotMatch(compose, /\n {2}release-orchestrator:\n/);
  assert.doesNotMatch(compose, /\n {2}release-provider-security-auditor:\n/);
  assert.match(orchestratorUnit, /release-orchestrator-%i\.env/);
  assert.match(orchestratorUnit, /^User=an-rel-worker-%i$/m);
  assert.match(orchestratorUnit, /release-orchestrator-%i-binding\.json/);
  assert.match(orchestratorUnit, /release-orchestrator-%i-app\.pem/);
  assert.match(auditorUnit, /release-auditor-%i\.env/);
  assert.match(auditorUnit, /^User=an-rel-auditor-%i$/m);
  assert.match(auditorUnit, /release-auditor-%i-policy\.json/);
  assert.match(auditorUnit, /release-auditor-%i-app\.pem/);
});

test("database gateways and runtime scripts bind claims and recovery to one environment", async () => {
  const [worker, migration, target] = await Promise.all([
    read("lib/restricted-cicd-worker.ts"),
    read("postgres/migrations/0087_restricted_cicd_environment_isolation.sql"),
    read("scripts/release-target-gateway.mjs"),
  ]);
  assert.match(worker, /release_workflow_recover_expired_dispatch_v2/);
  assert.match(worker, /release_workflow_claim_next_command_v2/);
  assert.match(worker, /binding\.environment/);
  assert.match(migration, /command\.environment=p_environment/);
  assert.match(migration, /dispatching\.environment=p_environment/);
  assert.match(migration, /run_binding\.environment=p_environment/);
  assert.match(target, /githubBinding\.environment\s*!==\s*adapterConfig\.environment/);
});

test("instance preflight rejects a staging binding paired with a production Auditor policy", () => {
  const sha = (letter) => letter.repeat(64);
  const binding = {
    provider: "github_actions", apiVersion: "2026-03-10", apiBaseUrl: "https://api.github.com",
    repositoryOwner: "agentnovas", repositoryName: "platform", repositoryId: "123",
    appId: "200", installationId: "201", accountId: "202",
    appPrivateKeyFile: "/run/secrets/release-orchestrator-app.pem",
    workflowId: "300", workflowPath: ".github/workflows/restricted-deployment.yml",
    workflowControlRef: "refs/tags/release-control-v1", controlCommitSha: "a".repeat(40),
    workflowSha256: sha("b"), environment: "staging",
    oidcAudience: "https://deploy.agentnovas.internal", runnerEnvironment: "github-hosted",
    g7ManifestSha256: sha("c"), providerBindingSha256: sha("d"),
    environmentPolicySha256: sha("e"), productionReviewerAllowlistSha256: sha("f"),
    runnerPolicySha256: sha("1"), targetBindingSha256: sha("2"), receiptTrustSha256: sha("3"),
    auditorTrustSha256: sha("4"),
  };
  binding.providerBindingSha256 = computeRestrictedCicdProviderBindingSha256(binding);
  const policy = {
    schemaVersion: "1", provider: "github_actions", apiVersion: "2026-03-10",
    apiBaseUrl: "https://api.github.com", repositoryOwner: "agentnovas", repositoryName: "platform",
    repositoryId: "123", accountId: "202", appId: "400", installationId: "401",
    workflowId: "300", controlCommitSha: "a".repeat(40), environment: "staging",
    environmentId: "500", rulesetId: "501", deploymentBranchPolicyId: "502",
    deploymentBranchPolicyName: "release-control-v1", runnerEnvironment: "github-hosted",
    reviewerAllowlist: [{ id: "600", type: "User" }], environmentPolicySha256: sha("e"),
    runnerPolicySha256: sha("1"), attestationKeyId: "auditor-staging-key",
  };
  assert.equal(verifyRestrictedCicdInstanceConfig({ environment: "staging", binding, policy }).environment, "staging");
  assert.throws(
    () => verifyRestrictedCicdInstanceConfig({
      environment: "production",
      binding,
      policy: { ...policy, environment: "production" },
    }),
    /instance binding mismatch/i,
  );
});
