import assert from "node:assert/strict";
import test from "node:test";

import { createInvocationOrchestrator } from "../packages/ai-control-plane/src/index.ts";

function candidate(rank, suffix) {
  return {
    fallbackRank: rank,
    policyRevisionId: "policy-revision-1",
    deploymentId: `deployment-${suffix}`,
    deploymentRevisionId: `deployment-revision-${suffix}`,
    connectionId: `connection-${suffix}`,
    connectionRevisionId: `connection-revision-${suffix}`,
    secretRef: `managed://ai/${suffix}.secret`,
  };
}

function memoryRepository() {
  const records = new Map();
  return {
    records,
    async begin(input) {
      const existing = records.get(input.invocationId);
      if (!existing) {
        records.set(input.invocationId, { input, status: "processing" });
        return { kind: "claimed" };
      }
      if (existing.input.requestHash !== input.requestHash) return { kind: "conflict" };
      if (existing.result) return { kind: "replay", result: existing.result };
      return { kind: "in_progress" };
    },
    async complete(result) {
      records.get(result.receipt.invocationId).result = result;
    },
  };
}

test("Gateway retries only transient failures in deterministic fallback order and emits usage", async () => {
  const repository = memoryRepository();
  const attempts = [];
  const events = [];
  const gateway = createInvocationOrchestrator({
    repository,
    resolveCandidates: async () => [candidate(0, "primary"), candidate(1, "fallback")],
    invokeCandidate: async ({ candidate: selected }) => {
      attempts.push(selected.fallbackRank);
      if (selected.fallbackRank === 0) throw { code: "timeout" };
      return { content: "standardized answer", usage: { inputTokens: 11, outputTokens: 7 } };
    },
    usageSink: { append: async (event) => events.push(event) },
  });

  const result = await gateway.invoke({
    invocationId: "invocation-1",
    requestHash: "a".repeat(64),
    roleKey: "client.assistant_message",
    operation: "assistant_message",
    trafficKind: "business",
    payload: { messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(result.content, "standardized answer");
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(result.receipt.selectedCandidate.fallbackRank, 1);
  assert.deepEqual(events.map((event) => event.status), ["requested", "attempted", "failed", "attempted", "succeeded"]);

  const replay = await gateway.invoke({
    invocationId: "invocation-1",
    requestHash: "a".repeat(64),
    roleKey: "client.assistant_message",
    operation: "assistant_message",
    trafficKind: "business",
    payload: {},
  });
  assert.equal(replay.content, "standardized answer");
  assert.deepEqual(attempts, [0, 1]);
});

test("Gateway never falls back on authentication errors and rejects idempotency conflicts", async () => {
  const repository = memoryRepository();
  let attempts = 0;
  const gateway = createInvocationOrchestrator({
    repository,
    resolveCandidates: async () => [candidate(0, "primary"), candidate(1, "fallback")],
    invokeCandidate: async () => {
      attempts += 1;
      throw { code: "authentication" };
    },
    usageSink: { append: async () => undefined },
  });
  const first = await gateway.invoke({
    invocationId: "invocation-auth",
    requestHash: "b".repeat(64),
    roleKey: "client.assistant_message",
    operation: "assistant_message",
    trafficKind: "business",
    payload: {},
  });
  assert.equal(first.receipt.status, "failed");
  assert.equal(first.receipt.errorCode, "authentication");
  assert.equal(attempts, 1);
  await assert.rejects(
    gateway.invoke({
      invocationId: "invocation-auth",
      requestHash: "c".repeat(64),
      roleKey: "client.assistant_message",
      operation: "assistant_message",
      trafficKind: "business",
      payload: {},
    }),
    (error) => error?.code === "AI_INVOCATION_IDEMPOTENCY_CONFLICT",
  );
});

test("Gateway cancellation is terminal and never advances the fallback chain", async () => {
  const repository = memoryRepository();
  const events = [];
  let attempts = 0;
  const gateway = createInvocationOrchestrator({
    repository,
    resolveCandidates: async () => [candidate(0,"primary"),candidate(1,"fallback")],
    invokeCandidate: async () => {
      attempts += 1;
      throw { code: "cancelled" };
    },
    usageSink: { append: async (event) => events.push(event) },
  });
  const result = await gateway.invoke({
    invocationId: "invocation-cancelled",requestHash: "d".repeat(64),
    roleKey: "client.assistant_message",operation: "assistant_message",
    trafficKind: "business",payload: {},
  });
  assert.equal(result.receipt.status,"cancelled");
  assert.equal(result.receipt.errorCode,"cancelled");
  assert.equal(attempts,1);
  assert.deepEqual(events.map(event => event.status),["requested","attempted","cancelled"]);
});
