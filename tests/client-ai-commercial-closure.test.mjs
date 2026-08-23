import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requestAiText } from "../lib/ai-provider.ts";
import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

const config = {
  providerName: "Fixture Provider",
  endpoint: "https://llm.example.test/v1/chat/completions",
  apiStyle: "chat_completions",
  model: "fixture-model",
  apiKey: "fixture-only-key",
  source: "platform",
  role: "report",
  profileId: "profile-1",
  revisionId: "revision-1",
};

test("provider output carries validated provider metering", async () => {
  const result = await requestAiText(config, [{ role: "user", content: "hello" }], {
    fetchImpl: async () => Response.json({
      id: "chatcmpl-fixture-1",
      choices: [{ message: { content: "measured answer" } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    }),
  });
  assert.deepEqual(result, {
    text: "measured answer",
    metering: {
      source: "provider_metering",
      providerRequestId: "chatcmpl-fixture-1",
      usageId: "chatcmpl-fixture-1",
      inputTokens: 123,
      outputTokens: 45,
    },
  });
});

test("provider output without a request id or reliable token usage fails closed", async () => {
  for (const payload of [
    { choices: [{ message: { content: "missing id" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { id: "chatcmpl-missing-usage", choices: [{ message: { content: "missing usage" } }] },
    { id: "chatcmpl-invalid-usage", choices: [{ message: { content: "bad usage" } }], usage: { prompt_tokens: 1.5, completion_tokens: -1 } },
  ]) {
    await assert.rejects(
      requestAiText(config, [{ role: "user", content: "hello" }], {
        fetchImpl: async () => Response.json(payload),
      }),
      /可靠.*(?:请求|用量)|计量/,
    );
  }
});

test("provider requests combine user cancellation with the bounded timeout", async () => {
  const controller = new AbortController();
  let providerSignal;
  const request = requestAiText(config, [{ role: "user", content: "cancel me" }], {
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      providerSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        providerSignal?.addEventListener("abort", () => reject(providerSignal.reason), { once: true });
        setTimeout(() => reject(new Error("external abort was not propagated")), 100);
      });
    },
  });
  controller.abort(new DOMException("cancelled by customer", "AbortError"));
  await assert.rejects(request, (error) => error?.name === "AbortError");
  assert.equal(providerSignal?.aborted, true);
});

test("Client model runtime uses the safe report/proposal projection and dedicated encryption key", async () => {
  const [resolver, migration, grants] = await Promise.all([
    source("../lib/client-platform-llm.ts"),
    source("../postgres/migrations/0038_client_ai_runtime_credits.sql"),
    source("../deploy/postgres/least-privilege-roles.sql"),
  ]);
  assert.match(migration, /CREATE(?: OR REPLACE)? VIEW client_ai_runtime_model_bindings/i);
  assert.match(migration, /role IN \('report','proposal_a'\)/i);
  assert.match(migration, /client_ai_inference_requests/i);
  assert.match(grants, /GRANT SELECT ON client_ai_runtime_model_bindings TO agentnovas_client_web/i);
  const clientSection = grants.match(/-- Client[\s\S]*?(?=-- Operations)/)?.[0] ?? "";
  assert.doesNotMatch(clientSection, /GRANT SELECT ON[\s\S]*?\b(?:llm_profiles|llm_profile_revisions|agent_role_bindings)\b/i);
  assert.match(resolver, /client_ai_runtime_model_bindings/);
  assert.match(resolver, /decryptLlmProfileSecret/);
  assert.doesNotMatch(resolver, /AI_API_(?:URL|KEY)|AI_MODEL|llm_profiles|llm_profile_revisions/);
});

test("both paid Client AI writes require idempotency and reserve/settle/release Credits", async () => {
  const [chatRoute, strategyRoute, chatUi] = await Promise.all([
    source("../app/api/ai/conversations/[id]/messages/route.client.ts"),
    source("../app/api/strategy-studio/generate/route.client.ts"),
    source("../apps/client/ui/ai-assistant-chat.tsx"),
  ]);
  for (const route of [chatRoute, strategyRoute]) {
    assert.match(route, /idempotencyKey\(request\)/);
    assert.match(route, /beginClientAiInference/);
    assert.match(route, /completeClientAiInference/);
    assert.match(route, /failClientAiInference/);
    assert.doesNotMatch(route, /AI_API_(?:URL|KEY)|resolveClientPlatformLlmConfig\(\)/);
  }
  const chatHandler = chatRoute.slice(chatRoute.indexOf("export async function POST"));
  const strategyHandler = strategyRoute.slice(strategyRoute.indexOf("export async function POST"));
  assert.ok(chatHandler.indexOf("readClientAiInferenceReplay(") < chatHandler.indexOf("generateAssistantReply({"));
  assert.ok(chatHandler.indexOf("beginClientAiInference(") < chatHandler.indexOf("generateAssistantReply({"));
  assert.ok(strategyHandler.indexOf("readClientAiInferenceReplay(") < strategyHandler.indexOf("generateStrategyProposal({"));
  assert.ok(strategyHandler.indexOf("beginClientAiInference(") < strategyHandler.indexOf("generateStrategyProposal({"));
  assert.match(chatHandler, /reconcileExpiredClientAiInferences/);
  assert.match(strategyHandler, /reconcileExpiredClientAiInferences/);
  assert.match(chatRoute, /"report"/);
  assert.match(strategyRoute, /"proposal_a"/);
  assert.doesNotMatch(chatUi, /"idempotency-key"\s*:\s*crypto\.randomUUID\(\)/);
  assert.match(chatUi, /type PendingAiRequest/);
  assert.match(chatUi, /pendingRequest\.idempotencyKey/);
  assert.match(chatUi, /AI_REQUEST_IN_PROGRESS/);
  assert.match(chatUi, /重试原请求/);
});

test("every Client AI conversation and generation API requires the effective paper workspace grant", async () => {
  const expected = [
    ["GET", "/api/ai/conversations"],
    ["POST", "/api/ai/conversations"],
    ["GET", "/api/ai/conversations/:id"],
    ["PATCH", "/api/ai/conversations/:id"],
    ["POST", "/api/ai/conversations/:id/messages"],
    ["POST", "/api/ai/conversations/:id/messages/:messageId/strategy"],
    ["POST", "/api/ai/inferences/:id/cancel"],
    ["POST", "/api/strategy-studio/generate"],
  ];
  for (const [method, route] of expected) {
    const entry = API_ROUTE_INVENTORY.find((candidate) => candidate.method === method && candidate.route === route);
    assert.ok(entry, `${method} ${route} is inventoried`);
    assert.equal(entry.authentication, "permission", `${method} ${route} must reject revoked Client access`);
    assert.deepEqual(entry.permissionKeys, ["client.paper.view"], `${method} ${route} must use the workspace grant`);
  }

  for (const path of [
    "../app/api/ai/conversations/route.client.ts",
    "../app/api/ai/conversations/[id]/route.client.ts",
    "../app/api/ai/conversations/[id]/messages/route.client.ts",
    "../app/api/ai/conversations/[id]/messages/[messageId]/strategy/route.client.ts",
    "../app/api/ai/inferences/[id]/cancel/route.client.ts",
    "../app/api/strategy-studio/generate/route.client.ts",
  ]) {
    const routeSource = await source(path);
    assert.match(routeSource, /requireAccessPermission\(request,\s*"client\.paper\.view"\)/);
  }
});

test("Client chat exposes a server-owned cancel target and never treats abort as an idempotent retry", async () => {
  const [chatRoute, cancelRoute, chatUi] = await Promise.all([
    source("../app/api/ai/conversations/[id]/messages/route.client.ts"),
    source("../app/api/ai/inferences/[id]/cancel/route.client.ts"),
    source("../apps/client/ui/ai-assistant-chat.tsx"),
  ]);
  assert.match(chatRoute, /inferenceRequestId:\s*claimed\.requestId/);
  assert.match(chatRoute, /signal:\s*request\.signal/);
  assert.match(cancelRoute, /cancelClientAiInference/);
  assert.match(cancelRoute, /idempotencyKey\(request\)/);
  assert.match(chatUi, /AbortController/);
  assert.match(chatUi, /取消生成/);
  assert.match(chatUi, /\/api\/ai\/inferences\/\$\{encodeURIComponent\([^)]*\)\}\/cancel/);
  assert.match(chatUi, /inferenceRequestId/);
  assert.doesNotMatch(chatUi, /setRetryRequest\([^)]*AI_REQUEST_CANCELLED/);
});
