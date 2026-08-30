import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ROLE_CATALOG,
  assertBindingPolicy,
  configurationFingerprint,
  createOpenAiCompatibleAdapter,
  deriveProbeHealth,
  evaluateCapabilities,
  evaluateSoftBudget,
  isRetryableProviderFailure,
  resolveBindingPlan,
} from "../packages/ai-control-plane/src/index.ts";

const now = new Date("2026-08-30T00:00:00.000Z");

test("exports the fixed twelve-role catalog without turning product stages into bindings", () => {
  assert.equal(AI_ROLE_CATALOG.length, 12);
  assert.deepEqual(
    AI_ROLE_CATALOG.filter((role) => role.consumer === "client").map((role) => role.key),
    ["client.assistant_message", "client.strategy_generation"],
  );
  assert.equal(AI_ROLE_CATALOG.some((role) => role.key.includes("execution")), false);
});

test("binding policies allow one primary and at most two unique fallbacks", () => {
  const policy = assertBindingPolicy({
    id: "policy-1",
    roleKey: "client.assistant_message",
    enabled: true,
    revisionId: "policy-revision-1",
    targets: [
      { deploymentId: "deployment-a", priority: 0 },
      { deploymentId: "deployment-b", priority: 1 },
      { deploymentId: "deployment-c", priority: 2 },
    ],
  });
  assert.equal(policy.targets.length, 3);
  assert.throws(
    () => assertBindingPolicy({ ...policy, targets: [...policy.targets, { deploymentId: "deployment-d", priority: 3 }] }),
    /at most three/i,
  );
  assert.throws(
    () => assertBindingPolicy({ ...policy, targets: [{ deploymentId: "deployment-a", priority: 1 }] }),
    /priority/i,
  );
});

test("resolves immutable connection and deployment revisions in fallback order", () => {
  const plan = resolveBindingPlan({
    policy: {
      id: "policy-1",
      roleKey: "client.assistant_message",
      enabled: true,
      revisionId: "policy-revision-1",
      targets: [
        { deploymentId: "deployment-a", priority: 0 },
        { deploymentId: "deployment-b", priority: 1 },
      ],
    },
    deployments: [
      { id: "deployment-a", enabled: true, currentRevisionId: "model-revision-a", connectionId: "connection-a" },
      { id: "deployment-b", enabled: true, currentRevisionId: "model-revision-b", connectionId: "connection-b" },
    ],
    connectionRevisions: [
      { connectionId: "connection-a", id: "connection-revision-a", enabled: true, secretRef: "secret-a" },
      { connectionId: "connection-b", id: "connection-revision-b", enabled: true, secretRef: "secret-b" },
    ],
  });
  assert.deepEqual(plan.map((candidate) => ({
    rank: candidate.fallbackRank,
    modelRevisionId: candidate.deploymentRevisionId,
    connectionRevisionId: candidate.connectionRevisionId,
  })), [
    { rank: 0, modelRevisionId: "model-revision-a", connectionRevisionId: "connection-revision-a" },
    { rank: 1, modelRevisionId: "model-revision-b", connectionRevisionId: "connection-revision-b" },
  ]);
});

test("only transient provider failures are eligible for fallback", () => {
  for (const code of ["network", "timeout", "rate_limited", "provider_5xx"]) {
    assert.equal(isRetryableProviderFailure({ code }), true, code);
  }
  for (const code of ["authentication", "configuration", "validation", "budget", "permission", "cancelled", "output_contract"]) {
    assert.equal(isRetryableProviderFailure({ code }), false, code);
  }
});

test("capability matching reports every unmet deterministic requirement", () => {
  const result = evaluateCapabilities({
    capability: {
      inputModalities: ["text"], outputModalities: ["text"], contextWindowTokens: 8_000,
      maxOutputTokens: 1_000, supportsStreaming: false, supportsStructuredOutput: false,
    },
    requirement: {
      inputModalities: ["text"], outputModalities: ["text"], minimumContextWindowTokens: 16_000,
      minimumMaxOutputTokens: 2_000, requiresStreaming: true, requiresStructuredOutput: true,
    },
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, [
    "context_window_too_small",
    "max_output_too_small",
    "streaming_not_supported",
    "structured_output_not_supported",
  ]);
});

test("probe health is fingerprint-bound and becomes stale after twenty-four hours", async () => {
  const fingerprint = await configurationFingerprint({
    adapterId: "openai-compatible",
    endpoint: "https://api.example.com/v1",
    secretVersion: "secret-v1",
    modelId: "model-a",
    capability: { maxOutputTokens: 2_000 },
  });
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const receipt = {
    id: "probe-1", configurationFingerprint: fingerprint, status: "succeeded",
    testedAt: "2026-08-29T12:00:00.000Z", expiresAt: "2026-08-30T12:00:00.000Z",
  };
  assert.equal(deriveProbeHealth({ receipt, expectedFingerprint: fingerprint, now }).state, "healthy");
  assert.equal(deriveProbeHealth({ receipt, expectedFingerprint: "0".repeat(64), now }).state, "configuration_changed");
  assert.equal(deriveProbeHealth({ receipt, expectedFingerprint: fingerprint, now: new Date("2026-08-31T00:00:00.000Z") }).state, "stale");
});

test("soft budgets alert at eighty and one hundred percent without blocking", () => {
  const warning = evaluateSoftBudget({ limit: "1000", used: "800" });
  const exceeded = evaluateSoftBudget({ limit: "1000", used: "1001" });
  assert.deepEqual(warning, { state: "warning", percentage: 80, shouldBlock: false });
  assert.deepEqual(exceeded, { state: "exceeded", percentage: 100.1, shouldBlock: false });
});

test("OpenAI-compatible adapter discovers models and normalizes chat usage through an injected transport", async () => {
  const calls = [];
  const adapter = createOpenAiCompatibleAdapter({
    transport: async (request) => {
      calls.push(request);
      if (request.url.endsWith("/models")) {
        return { status: 200, body: { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] } };
      }
      return {
        status: 200,
        headers: { "x-request-id": "provider-request-1" },
        body: {
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
        },
      };
    },
  });
  assert.deepEqual(await adapter.discoverModels({ endpoint: "https://api.example.com/v1", apiKey: "test-key" }), ["model-a", "model-b"]);
  const result = await adapter.invoke({
    endpoint: "https://api.example.com/v1", apiKey: "test-key", modelId: "model-a",
    messages: [{ role: "user", content: "hi" }], maxOutputTokens: 20,
  });
  assert.deepEqual(result, {
    content: "hello",
    providerRequestId: "provider-request-1",
    usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
  });
  assert.equal(calls[1].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[1].headers.authorization, "Bearer test-key");
});

test("OpenAI-compatible adapter classifies provider errors without leaking response payloads", () => {
  const adapter = createOpenAiCompatibleAdapter({ transport: async () => ({ status: 500, body: {} }) });
  assert.deepEqual(adapter.classifyError({ status: 401 }), { code: "authentication", status: 401 });
  assert.deepEqual(adapter.classifyError({ status: 429 }), { code: "rate_limited", status: 429 });
  assert.deepEqual(adapter.classifyError({ status: 503 }), { code: "provider_5xx", status: 503 });
  assert.deepEqual(adapter.classifyError({ name: "AbortError" }), { code: "timeout" });
});
