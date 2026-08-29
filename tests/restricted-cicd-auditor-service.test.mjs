import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("auditor is default-off, independently custodied, read-only, and target-gated", async () => {
  const [service, auditor, target, compose, environment, roles, packageJson] = await Promise.all([
    read("scripts/release-provider-security-auditor.mjs"), read("lib/restricted-cicd-auditor.ts"),
    read("scripts/release-target-gateway.mjs"),
    read("deploy/container/compose.yml"), read("deploy/env/release-auditor.env.example"),
    read("deploy/postgres/least-privilege-roles.sql"), read("package.json"),
  ]);
  assert.match(environment, /RELEASE_AUDITOR_ENABLED=false/);
  assert.match(service, /agentnovas_release_auditor/);
  assert.match(service, /actions:\s*"read"/);
  assert.match(service, /administration:\s*"read"/);
  assert.doesNotMatch(service, /actions:\s*"write"|workflow_dispatch|\/logs|\/artifacts|\/caches/);
  assert.match(auditor, /release_workflow_append_run_policy_attestation/);
  assert.match(compose, /release-provider-security-auditor-staging:/);
  assert.match(compose, /release-provider-security-auditor-production:/);
  assert.match(compose, /release-auditor-staging-app\.pem/);
  assert.match(compose, /release-auditor-production-app\.pem/);
  assert.match(compose, /release-auditor-staging-attestation-ed25519\.pem/);
  assert.match(compose, /release-auditor-production-attestation-ed25519\.pem/);
  assert.match(target, /RELEASE_TARGET_AUDITOR_URL/);
  assert.match(target, /auditRestrictedCicdTargetRun/);
  assert.match(roles, /'agentnovas_release_auditor',[\s\S]{0,100}'agentnovas_release_target_gateway'[\s\S]{0,500}CREATE ROLE %I LOGIN/);
  assert.match(packageJson, /"service:release-auditor"/);
});
