import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Maintenance exposes a bounded redacted control-plane API surface", async () => {
  const [snapshot,configurations,secretKey,secretCommands,bindings,probes,budgets,rollback] = await Promise.all([
    read("app/api/maintenance/ai-control-plane/snapshot/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/configurations/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/secret-key/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/secret-commands/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/bindings/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/probes/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/budgets/route.maintenance.ts"),
    read("app/api/maintenance/ai-control-plane/deployments/[id]/revisions/route.maintenance.ts"),
  ]);
  assert.match(snapshot,/getAiControlPlaneSnapshot/);
  assert.match(snapshot,/requireAnyAccessPermission/);
  assert.doesNotMatch(snapshot,/secret_ref|endpoint|ciphertext|provider_request_id/i);
  for (const source of [configurations,secretCommands,bindings,probes,budgets,rollback]) {
    assert.match(source,/requireAccessPermission/);
    assert.match(source,/automaticAuditReason/);
    assert.doesNotMatch(source,/body\.reason/);
    assert.doesNotMatch(source,/decryptLlmProfileSecret|encryptLlmProfileSecret/);
  }
  assert.match(secretKey,/readActiveSecretBrokerKey/);
  assert.match(configurations,/saveConnectionDeployment/);
  assert.match(secretCommands,/enqueueSecretCommand/);
  assert.match(bindings,/updateBindingPolicy/);
  assert.match(probes,/requestAiGatewayProbe/);
  assert.match(budgets,/upsertBudgetPolicy/);
  assert.match(rollback,/rollbackControlPlaneDeployment/);
});

test("Client Web resolves safe bindings and invokes only the loopback Gateway", async () => {
  const [resolver,provider,clientEnvironment,keyCustody] = await Promise.all([
    read("lib/client-platform-llm.ts"),
    read("lib/ai-provider.ts"),
    read("deploy/env/client.env.example"),
    read("scripts/quality/check-web-key-custody.mjs"),
  ]);
  assert.match(resolver,/client_ai_control_plane_bindings_safe/);
  assert.doesNotMatch(resolver,/encrypted_api_key|decryptLlmProfileSecret|endpoint|apiKey/);
  assert.match(provider,/requestAiGatewayInvocation/);
  assert.doesNotMatch(provider,/authorization:\s*`Bearer|config\.apiKey|config\.endpoint/);
  assert.doesNotMatch(clientEnvironment,/LLM_PROFILE_ENCRYPTION_KEY/);
  assert.match(clientEnvironment,/AI_GATEWAY_ENABLED=false/);
  assert.match(keyCustody,/LLM_PROFILE_ENCRYPTION_KEY/);
  assert.match(keyCustody,/decryptLlmProfileSecret/);
});

test("Maintenance models workspace consumes the reusable React package through its public export", async () => {
  const source = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.match(source,/@agentnovas\/ai-control-plane-react/);
  assert.match(source,/AiControlPlaneManager/);
  assert.match(source,/AI_ROLE_CATALOG/);
  assert.doesNotMatch(source,/apiKey:\s*form\.apiKey/);
});
