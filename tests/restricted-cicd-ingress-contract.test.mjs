import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("release webhook ingress is independent, exact-path, default-off, and secret-file based", async () => {
  const [script, environment, binding, compose, systemd, packageJson, nginx] = await Promise.all([
    read("scripts/release-webhook-ingress.mjs"),
    read("deploy/env/release-webhook.env.example"),
    read("deploy/env/release-webhook-binding.json.example").then(JSON.parse),
    read("deploy/container/compose.yml"),
    read("deploy/systemd/agentnovas-release-webhook-ingress.service"),
    read("package.json").then(JSON.parse),
    read("deploy/nginx/riverton-three-apps.conf"),
  ]);
  assert.match(script, /RELEASE_WEBHOOK_INGRESS_ENABLED\s*!==\s*"true"/);
  assert.match(script, /request\.url\s*!==\s*"\/internal\/release-webhook\/github"/);
  assert.match(script, /agentnovas_release_ingress/);
  assert.doesNotMatch(script, /WEBHOOK_SECRET\s*=|process\.env\.[A-Z_]*WEBHOOK_SECRET(?!_FILE)|console\.(?:log|error)[^\n]*(?:rawBody|webhookSecret|signature)/i);
  assert.match(environment, /^RELEASE_WEBHOOK_INGRESS_ENABLED=false$/m);
  assert.match(environment, /^RELEASE_WEBHOOK_DATABASE_URL=postgresql:\/\/agentnovas_release_ingress:/m);
  assert.equal(binding.webhookSecretFile, "/run/secrets/release-webhook-secret");
  assert.equal(Object.hasOwn(binding, "webhookSecret"), false);
  assert.match(packageJson.scripts["service:release-webhook-ingress"], /release-webhook-ingress\.mjs/);
  assert.match(systemd, /^User=agentnovas-release-ingress$/m);
  assert.match(systemd, /^Group=agentnovas-release-ingress$/m);
  assert.match(systemd, /LoadCredential=release-webhook-binding\.json:\/etc\/agentnovas\/release-webhook-binding\.json/);
  assert.match(systemd, /LoadCredential=release-webhook-secret:\/etc\/agentnovas\/release-webhook-secret/);
  assert.match(systemd, /^Environment=RELEASE_WEBHOOK_BINDING_FILE=%d\/release-webhook-binding\.json$/m);
  assert.match(systemd, /^Environment=RELEASE_WEBHOOK_SECRET_FILE=%d\/release-webhook-secret$/m);
  assert.match(systemd, /^InaccessiblePaths=\/etc\/agentnovas$/m);
  assert.match(systemd, /^ProtectProc=invisible$/m);
  assert.match(systemd, /^ProcSubset=pid$/m);
  assert.doesNotMatch(systemd, /^User=agentnovas$/m);
  assert.doesNotMatch(nginx, /release-webhook|restricted-cicd/i, "public route remains absent before T8.2d/G7");

  const service = compose.match(/\n {2}release-webhook-ingress:\n([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(service, /profiles:\s*\[restricted-cicd\]/);
  assert.match(service, /release-webhook-ingress\.mjs/);
  assert.match(service, /networks:\s*\[backplane, edge\]/);
  assert.doesNotMatch(service, /\begress\b/);
});

test("systemd identities and credential namespaces remain isolated from every Web process", async () => {
  const [worker, ingress, ...webUnits] = await Promise.all([
    read("deploy/systemd/agentnovas-release-orchestrator@.service"),
    read("deploy/systemd/agentnovas-release-webhook-ingress.service"),
    read("deploy/systemd/riverton-client.service"),
    read("deploy/systemd/riverton-operations.service"),
    read("deploy/systemd/riverton-maintenance.service"),
  ]);
  const user = (source) => source.match(/^User=(.+)$/m)?.[1];
  assert.deepEqual(new Set([user(worker), user(ingress), ...webUnits.map(user)]), new Set([
    "an-rel-worker-%i",
    "agentnovas-release-ingress",
    "agentnovas",
  ]));
  assert.notEqual(user(worker), user(ingress));
  for (const source of [worker, ingress, ...webUnits]) {
    assert.match(source, /^InaccessiblePaths=\/etc\/agentnovas$/m);
  }
  assert.doesNotMatch(ingress, /release-orchestrator-app\.pem/);
  assert.doesNotMatch(worker, /release-webhook-secret/);
});

test("disabled ingress exits before database, binding, or webhook secret access", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/release-webhook-ingress.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, RELEASE_WEBHOOK_INGRESS_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELEASE_WEBHOOK_INGRESS_ENABLED must be true/);
  assert.doesNotMatch(result.stderr, /DATABASE_URL is required|binding unavailable|webhook secret unavailable/i);
});

test("release ingress gets only append-delivery gateway and no direct database access", async () => {
  const [roles, policy, ingress] = await Promise.all([
    read("deploy/postgres/least-privilege-roles.sql"),
    read("scripts/release/postgres-role-policy.mjs"),
    read("lib/restricted-cicd-ingress.ts"),
  ]);
  const grant = roles.match(/GRANT EXECUTE ON FUNCTION\s+public\.release_workflow_append_delivery\([^)]+\)\s+TO agentnovas_release_ingress;/)?.[0] ?? "";
  assert.match(grant, /release_workflow_append_delivery/);
  assert.doesNotMatch(grant, /_claim_|_lease_|bind_provider|append_provider_event|target_receipt|authorization/);
  assert.match(policy, /agentnovas_release_ingress/);
  assert.match(ingress, /release_workflow_append_delivery/);
  assert.doesNotMatch(roles, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO agentnovas_release_ingress/i);
});
