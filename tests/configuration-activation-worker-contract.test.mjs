import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("configuration activation worker is explicitly gated, observable and deployment-ready", async () => {
  const [script, systemd, workerEnvironment, maintenanceEnvironment, packageJson, health, contract, ui, compose, audit] = await Promise.all([
    read("scripts/configuration-activation-worker.mjs"),
    read("deploy/systemd/riverton-configuration-activation-worker.service"),
    read("deploy/env/configuration-activation.env.example"),
    read("deploy/env/maintenance.env.example"),
    read("package.json").then(JSON.parse),
    read("app/api/maintenance/payment-workers/health/route.maintenance.ts"),
    read("packages/contracts/src/riverton-ui.ts"),
    read("apps/maintenance/ui/system-health-workspace.tsx"),
    read("deploy/container/compose.yml"),
    read("scripts/audit-production-config.sh"),
  ]);

  assert.match(script, /CONFIGURATION_ACTIVATION_WORKER_ENABLED\s*!==\s*"true"/);
  assert.match(script, /CONFIGURATION_ACTIVATION_DATABASE_URL/);
  assert.match(script, /workerType:\s*"configuration_activation"/);
  assert.match(script, /runDueConfigurationActivations/);
  assert.match(script, /heartbeat\.markFailure/);
  assert.doesNotMatch(script, /fetch\(|https?:\/\//);
  assert.match(systemd, /configuration-activation\.env/);
  assert.match(systemd, /worker:configuration-activation/);
  assert.match(workerEnvironment, /^CONFIGURATION_ACTIVATION_WORKER_ENABLED=false$/m);
  assert.match(workerEnvironment, /^CONFIGURATION_ACTIVATION_DATABASE_URL=postgresql:\/\/agentnovas_configuration_activation_worker:/m);
  assert.match(maintenanceEnvironment, /^CONFIGURATION_ACTIVATION_WORKER_ENABLED=false$/m);
  assert.match(packageJson.scripts["worker:configuration-activation"], /scripts\/configuration-activation-worker\.mjs/);
  assert.match(health, /configurationActivationWorker/);
  assert.match(health, /"configuration_activation"/);
  assert.match(contract, /configurationActivationWorker/);
  assert.match(ui, /Configuration Activation Worker/);
  const service = compose.match(/\n {2}configuration-activation-worker:\n([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(service, /configuration-activation\.env/);
  assert.match(service, /scripts\/configuration-activation-worker\.mjs/);
  assert.match(service, /networks:\s*\[backplane\]/);
  assert.doesNotMatch(service, /egress|edge/);
  assert.match(audit, /configuration-activation\.env/);
  assert.match(audit, /CONFIGURATION_ACTIVATION_WORKER_ENABLED/);
});

test("configuration activation worker has a narrow append-only database capability", async () => {
  const [worker, migration, grants, policy] = await Promise.all([
    read("lib/configuration-activation-worker.ts"),
    read("postgres/migrations/0070_configuration_activation_worker.sql"),
    read("deploy/postgres/least-privilege-roles.sql"),
    read("scripts/release/postgres-role-policy.mjs"),
  ]);

  assert.match(worker, /pg_try_advisory_lock/);
  assert.match(worker, /pg_advisory_unlock/);
  assert.match(worker, /configuration_schedules/);
  assert.match(worker, /scheduled_for\s*<=/);
  assert.match(worker, /NOT EXISTS[\s\S]+configuration_activations/);
  assert.match(migration, /actor_kind[\s\S]+worker/);
  assert.match(worker, /configuration_activation_worker_activate/);
  assert.doesNotMatch(worker, /INSERT INTO configuration_approvals|action[^\n]+rollback|fetch\(/i);
  assert.match(migration, /configuration_activation/);
  assert.match(migration, /actor_kind/);
  assert.match(migration, /actor_identity/);
  assert.match(migration, /idx_configuration_schedules_due/);
  assert.match(migration, /configuration_activation_worker_activate/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /CURRENT_TIMESTAMP/);
  assert.match(grants, /agentnovas_configuration_activation_worker/);
  assert.match(grants, /GRANT SELECT ON[\s\S]+configuration_versions[\s\S]+TO agentnovas_configuration_activation_worker/i);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON worker_instances\s+TO agentnovas_configuration_activation_worker/i);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION\s+public\.configuration_activation_worker_activate\(text\)\s+TO agentnovas_configuration_activation_worker/i);
  assert.doesNotMatch(grants, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*(?:configuration_approvals|configuration_activations|audit_logs)[^;]*TO agentnovas_configuration_activation_worker/i);
  assert.doesNotMatch(grants, /GRANT[^;]+ON SEQUENCE[^;]+TO agentnovas_configuration_activation_worker/i);
  assert.match(policy, /agentnovas_configuration_activation_worker/);
});
