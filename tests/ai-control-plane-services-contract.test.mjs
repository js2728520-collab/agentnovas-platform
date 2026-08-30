import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Secret Broker and AI Gateway are independent disabled-by-default processes", async () => {
  const [packageJson,brokerScript,gatewayScript,brokerEnvironment,gatewayEnvironment,brokerUnit,gatewayUnit,roles,nginx] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("scripts/ai-secret-broker-worker.mjs"),
    read("scripts/ai-gateway-server.mjs"),
    read("deploy/env/ai-secret-broker.env.example"),
    read("deploy/env/ai-gateway.env.example"),
    read("deploy/systemd/agentnovas-ai-secret-broker.service"),
    read("deploy/systemd/agentnovas-ai-gateway.service"),
    read("deploy/postgres/least-privilege-roles.sql"),
    read("deploy/nginx/riverton-three-apps.conf"),
  ]);
  assert.match(packageJson.scripts["worker:ai-secret-broker"],/NODE_USE_ENV_PROXY=1/);
  assert.match(packageJson.scripts["service:ai-gateway"],/NODE_USE_ENV_PROXY=1/);
  assert.match(brokerScript,/AI_SECRET_BROKER_ENABLED !== "true"/);
  assert.match(gatewayScript,/AI_GATEWAY_ENABLED !== "true"/);
  assert.match(gatewayScript,/server\.listen\(port,"127\.0\.0\.1"/);
  assert.doesNotMatch(gatewayScript,/0\.0\.0\.0/);
  assert.doesNotMatch(gatewayScript,/PRIVATE_KEY|LLM_PROFILE_ENCRYPTION_KEY/);
  assert.match(brokerEnvironment,/^AI_SECRET_BROKER_ENABLED=false$/m);
  assert.match(gatewayEnvironment,/^AI_GATEWAY_ENABLED=false$/m);
  assert.match(brokerEnvironment,/postgresql:\/\/agentnovas_ai_secret_broker:/);
  assert.match(gatewayEnvironment,/postgresql:\/\/agentnovas_ai_gateway:/);
  assert.match(brokerUnit,/LoadCredential=ai-broker-private\.pem/);
  assert.match(brokerUnit,/ReadWritePaths=\/var\/lib\/agentnovas\/ai-secrets/);
  assert.match(gatewayUnit,/ReadOnlyPaths=\/var\/lib\/agentnovas\/ai-secrets/);
  assert.match(gatewayUnit,/InaccessiblePaths=\/etc\/agentnovas\/secrets/);
  assert.match(roles,/agentnovas_ai_secret_broker/);
  assert.match(roles,/agentnovas_ai_gateway/);
  assert.doesNotMatch(nginx,/ai-gateway|3030/i);
});

test("disabled service startup exits before database or key access", () => {
  const broker = spawnSync(process.execPath,["--experimental-strip-types","scripts/ai-secret-broker-worker.mjs"],{
    cwd: new URL("..",import.meta.url),
    env: { ...process.env,AI_SECRET_BROKER_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.equal(broker.status,0);
  assert.match(broker.stdout,/disabled/i);
  assert.doesNotMatch(`${broker.stdout}${broker.stderr}`,/database URL|private key/i);

  const gateway = spawnSync(process.execPath,["--experimental-strip-types","scripts/ai-gateway-server.mjs"],{
    cwd: new URL("..",import.meta.url),
    env: { ...process.env,AI_GATEWAY_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.equal(gateway.status,0);
  assert.match(gateway.stdout,/disabled/i);
  assert.doesNotMatch(`${gateway.stdout}${gateway.stderr}`,/database URL|shared secret/i);
});
