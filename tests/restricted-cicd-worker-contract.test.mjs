import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("release orchestrator is an independent, explicitly disabled process with file-based key custody", async () => {
  const [script, packageJson, environment, binding, systemd, compose, audit] = await Promise.all([
    read("scripts/release-orchestrator-worker.mjs"),
    read("package.json").then(JSON.parse),
    read("deploy/env/release-orchestrator.env.example"),
    read("deploy/env/release-orchestrator-binding.json.example").then(JSON.parse),
    read("deploy/systemd/agentnovas-release-orchestrator@.service"),
    read("deploy/container/compose.yml"),
    read("scripts/audit-production-config.sh"),
  ]);

  assert.match(script, /RELEASE_ORCHESTRATOR_WORKER_ENABLED\s*!==\s*"true"/);
  assert.match(script, /agentnovas_release_worker/);
  assert.match(script, /loadGithubAppPrivateKey/);
  assert.match(script, /runRestrictedCicdReconciliationIteration/);
  assert.match(script, /runRestrictedCicdWorkerIteration/);
  assert.ok(
    script.indexOf("runRestrictedCicdReconciliationIteration")
      < script.lastIndexOf("runRestrictedCicdWorkerIteration"),
    "provider reconciliation must run before the independent dispatch pass",
  );
  assert.doesNotMatch(
    script,
    /reconciliation\.outcome\s*===\s*["']idle["'][\s\S]{0,200}runRestrictedCicdWorkerIteration/,
    "a non-idle reconciliation item must not suppress dispatch for another environment",
  );
  assert.doesNotMatch(script, /process\.env\.[A-Z_]*PRIVATE_KEY(?!_FILE)|-----BEGIN [A-Z ]*PRIVATE KEY-----|console\.(?:log|error)[^\n]*(?:token|privateKey|binding)/i);
  assert.match(packageJson.scripts["worker:release-orchestrator"], /NODE_USE_ENV_PROXY=1/);
  assert.match(packageJson.scripts["worker:release-orchestrator"], /release-orchestrator-worker\.mjs/);
  assert.match(environment, /^RELEASE_ORCHESTRATOR_WORKER_ENABLED=false$/m);
  assert.match(environment, /^RELEASE_ORCHESTRATOR_DATABASE_URL=postgresql:\/\/agentnovas_release_worker:/m);
  assert.match(environment, /^RELEASE_ORCHESTRATOR_BINDING_FILE=\/run\/secrets\/release-orchestrator-binding\.json$/m);
  assert.equal(binding.appPrivateKeyFile, "/run/secrets/release-orchestrator-app.pem");
  assert.equal(Object.hasOwn(binding, "appPrivateKey"), false);
  assert.match(systemd, /^User=an-rel-worker-%i$/m);
  assert.match(systemd, /^Group=an-rel-worker-%i$/m);
  assert.match(systemd, /release-orchestrator-%i\.env/);
  assert.match(systemd, /worker:release-orchestrator/);
  assert.match(systemd, /NoNewPrivileges=true/);
  assert.match(systemd, /LoadCredential=release-orchestrator-%i-binding\.json:\/etc\/agentnovas\/release-orchestrator-%i-binding\.json/);
  assert.match(systemd, /LoadCredential=release-orchestrator-%i-app\.pem:\/etc\/agentnovas\/release-orchestrator-%i-app\.pem/);
  assert.match(systemd, /^Environment=RELEASE_ORCHESTRATOR_BINDING_FILE=%d\/release-orchestrator-%i-binding\.json$/m);
  assert.match(systemd, /^Environment=RELEASE_ORCHESTRATOR_APP_PRIVATE_KEY_FILE=%d\/release-orchestrator-%i-app\.pem$/m);
  assert.match(systemd, /^InaccessiblePaths=\/etc\/agentnovas$/m);
  assert.match(systemd, /^ProtectProc=invisible$/m);
  assert.match(systemd, /^ProcSubset=pid$/m);
  assert.doesNotMatch(systemd, /^User=agentnovas$/m);

  for (const targetEnvironment of ["staging", "production"]) {
    const service = compose.match(new RegExp(`\\n {2}release-orchestrator-${targetEnvironment}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z-]+:|\\nsecrets:)`))?.[1] ?? "";
    assert.match(service, /profiles:\s*\[restricted-cicd\]/);
    assert.match(service, /release-orchestrator-worker\.mjs/);
    assert.match(service, new RegExp(`source: release_orchestrator_${targetEnvironment}_app_key`));
    assert.match(service, /mode:\s*0400/);
    assert.match(service, /networks:\s*\[backplane, egress\]/);
    assert.doesNotMatch(service, /\bedge\b/);
  }
  assert.match(audit, /release-orchestrator-staging/);
  assert.match(audit, /release-orchestrator-production/);
  assert.match(audit, /RELEASE_ORCHESTRATOR_WORKER_ENABLED/);
  assert.match(audit, /app\.pem:400/);
});

test("disabled startup fails before any database, binding, or private-key access", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/release-orchestrator-worker.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, RELEASE_ORCHESTRATOR_WORKER_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELEASE_ORCHESTRATOR_WORKER_ENABLED must be true/);
  assert.doesNotMatch(result.stderr, /DATABASE_URL is required|binding unavailable|private key unavailable/i);
});

test("release Worker receives only claim/dispatch/evidence gateways and no direct lease or table grants", async () => {
  const [roles, policy, worker] = await Promise.all([
    read("deploy/postgres/least-privilege-roles.sql"),
    read("scripts/release/postgres-role-policy.mjs"),
    read("lib/restricted-cicd-worker.ts"),
  ]);
  const grant = roles.match(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO agentnovas_release_worker;/)?.[1] ?? "";
  for (const routine of [
    "release_workflow_claim_next_command_v2",
    "release_workflow_claim_next_reconciliation_v2",
    "release_workflow_recover_expired_dispatch_v2",
    "release_workflow_begin_dispatch",
    "release_workflow_record_dispatch_unknown",
    "release_workflow_bind_provider_run",
    "release_workflow_reject_bound_run",
    "release_workflow_append_provider_event",
  ]) {
    assert.match(grant, new RegExp(routine));
    assert.match(policy, new RegExp(routine));
    assert.match(worker, new RegExp(routine));
  }
  assert.doesNotMatch(grant, /release_workflow_lease_command/);
  assert.doesNotMatch(roles, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO agentnovas_release_worker/i);
  assert.doesNotMatch(worker, /SELECT\s+[^;]*\s+FROM\s+release_workflow_(?:commands|approvals|activations|attempts)/i);
  const loginRoles = roles.match(/FOREACH role_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)?.[1] ?? "";
  const noLoginRoles = roles.match(/FOREACH role_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP[\s\S]*?FOREACH role_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)?.[2] ?? "";
  assert.match(loginRoles, /agentnovas_release_worker/);
  assert.doesNotMatch(noLoginRoles, /agentnovas_release_worker/);
});
