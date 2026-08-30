import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { apiPolicyForRoute, ApiPolicyError, evaluateApiRequestPolicy } from "../lib/api-policy.ts";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("Client BYOK endpoints are disabled by the central Beta inventory and return 503", async () => {
  for (const [method, route] of [
    ["GET", "/api/account/llm-config"],
    ["PUT", "/api/account/llm-config"],
    ["POST", "/api/account/llm-config/test"],
  ]) {
    const policy = apiPolicyForRoute(route, method);
    assert.deepEqual(policy.audiences, ["client"]);
    assert.equal(policy.authentication, "disabled");
    assert.throws(
      () => evaluateApiRequestPolicy(new Request(`https://agentnovas.com${route}`, {
        method,
        ...(method === "GET" ? {} : { headers: { origin: "https://agentnovas.com" } }),
      })),
      (error) => error instanceof ApiPolicyError
        && error.code === "ROUTE_DISABLED"
        && error.status === 503,
    );
  }

  const [{ GET, PUT }, { POST }] = await Promise.all([
    import("../app/api/account/llm-config/route.client.ts"),
    import("../app/api/account/llm-config/test/route.client.ts"),
  ]);
  for (const [handler, method, path] of [
    [GET, "GET", "/api/account/llm-config"],
    [PUT, "PUT", "/api/account/llm-config"],
    [POST, "POST", "/api/account/llm-config/test"],
  ]) {
    const response = await handler(new Request(`https://agentnovas.com${path}`, { method }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "ROUTE_DISABLED");
  }
  const routeSources = await Promise.all([
    source("../app/api/account/llm-config/route.client.ts"),
    source("../app/api/account/llm-config/test/route.client.ts"),
  ]);
  assert.doesNotMatch(routeSources.join("\n"), /getDb|llmConfigurations|request\.json|saveLlmConfig|testLlmConfig/);
});

test("Client-reachable workspaces contain no private key, endpoint, or BYOK module entry", async () => {
  const sources = await Promise.all([
    source("../apps/client/ui/ai-assistant-chat.tsx"),
    source("../apps/client/ui/strategy-studio.tsx"),
  ]);
  const reachable = sources.join("\n");
  assert.doesNotMatch(reachable, /CustomLlmButton|account\/llm-config|\.\/llm-config/);
  assert.doesNotMatch(reachable, /自定义\s*(?:API|大模型)|Custom\s*(?:API|LLM)|接口基础地址/i);
  assert.doesNotMatch(reachable, /<input[^>]+(?:name|value)=["{]?apiKey/i);
});

test("Client AI uses only the platform model configuration and fails closed when it is absent", async () => {
  const { resolveClientPlatformLlmConfig } = await import("../lib/client-platform-llm.ts");
  assert.equal(await resolveClientPlatformLlmConfig({ query: async () => ({ rows: [] }) }, "report"), null);
  const row = {
    role: "report",control_plane_role: "assistant_message",
    profile_id: "profile-1",revision_id: "revision-1",provider_name: "Platform AI",
    model_name: "platform-model",binding_policy_revision_id: "binding-revision-1",
  };
  assert.equal(await resolveClientPlatformLlmConfig({ query: async () => ({ rows: [{ ...row,control_plane_role: "strategy_generation" }] }) }, "report"), null);
  assert.deepEqual(await resolveClientPlatformLlmConfig({ query: async () => ({ rows: [row] }) }, "report"), {
    providerName: "Platform AI",model: "platform-model",source: "platform",role: "report",
    roleKey: "client.assistant_message",profileId: "profile-1",revisionId: "revision-1",
    bindingPolicyRevisionId: "binding-revision-1",
  });

  const [conversationRoute, strategyRoute, resolver] = await Promise.all([
    source("../app/api/ai/conversations/[id]/messages/route.client.ts"),
    source("../app/api/strategy-studio/generate/route.client.ts"),
    source("../lib/client-platform-llm.ts"),
  ]);
  for (const route of [conversationRoute, strategyRoute]) {
    assert.match(route, /resolveClientPlatformLlmConfig/);
    assert.match(route, /PLATFORM_MODEL_NOT_CONFIGURED/);
    assert.doesNotMatch(route, /resolveLlmConfig|llmConfigurations|user-\$\{/);
  }
  assert.doesNotMatch(resolver, /getDb|llmConfigurations|userId|encryptedApiKey|decryptLlmProfileSecret|apiKey|endpoint/);
});

test("Client database grants remain independent of legacy LLM configuration storage", async () => {
  const [sql, policy] = await Promise.all([
    source("../deploy/postgres/least-privilege-roles.sql"),
    source("../scripts/release/postgres-role-policy.mjs"),
  ]);
  const clientGrants = sql.match(/-- Client[\s\S]*?(?=-- Operations)/)?.[0] ?? "";
  assert.ok(clientGrants);
  assert.doesNotMatch(clientGrants, /llm_configurations/);
  assert.match(policy, /\["agentnovas_client_web", new Set\(\[[\s\S]*?"llm_configurations"/);
});
