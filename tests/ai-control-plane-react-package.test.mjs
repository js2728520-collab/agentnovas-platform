import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AiControlPlaneManager,AiUsageManager } from "../packages/ai-control-plane-react/dist/index.js";

const snapshot = {
  connections: [{
    id: "connection-1", name: "Primary provider", adapterId: "openai-compatible", enabled: true,
    currentRevisionId: "connection-revision-1", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
  }],
  deployments: [{ id: "deployment-1", name: "Fast model", connectionId: "connection-1", enabled: true, currentRevisionId: "deployment-revision-1" }],
  deploymentRevisions: [{
    id: "deployment-revision-1",deploymentId: "deployment-1",deploymentName: "Fast model",
    revisionNumber: 1,modelId: "fast-model",capability: {
      inputModalities: ["text"],outputModalities: ["text"],contextWindowTokens: 32000,
      maxOutputTokens: 2000,supportsStreaming: true,supportsStructuredOutput: false,
    },defaultMaxOutputTokens: 2000,defaultTimeoutMs: 30000,enabled: true,isCurrent: true,
    createdAt: "2026-08-30T00:00:00.000Z",
  }],
  bindings: [{
    id: "binding-1", roleKey: "client.assistant_message", revisionId: "binding-revision-1", enabled: true,
    targets: [{ deploymentId: "deployment-1", priority: 0 }],
  }],
  probes: [{
    id: "probe-1", configurationFingerprint: "a".repeat(64), status: "succeeded",
    phase: "invocation",models: ["fast-model"],
    testedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z", latencyMs: 120,
  }],
  budgets: [{ id: "budget-1", scope: "platform", scopeId: "platform", unit: "tokens", limit: "1000", warningPercentage: 80, enabled: true }],
};

const messages = {
  title: "AI control plane",
  refresh: "Refresh",
  loading: "Loading",
  error: "Unable to load",
  empty: "Nothing configured",
  connections: "Connections",
  deployments: "Deployments",
  revisions: "Revisions",
  bindings: "Bindings",
  probes: "Probe history",
  budgets: "Budgets",
  enabled: "Enabled",
  disabled: "Disabled",
  primary: "Primary",
  fallback: "Fallback",
  current: "Current",
};

test("renders an accessible, host-labelled control-plane summary without AgentNovas-specific URLs or RBAC", () => {
  const html = renderToStaticMarkup(createElement(AiControlPlaneManager, {
    client: { snapshot: async () => snapshot, refresh: async () => snapshot },
    initialSnapshot: snapshot,
    roles: [{
      key: "client.assistant_message", consumer: "client", role: "assistant_message", label: "Assistant",
      runtimeState: "gated", requirement: { inputModalities: ["text"], outputModalities: ["text"] },
    }],
    messages,
    formatDateTime: (value) => value.slice(0, 10),
    formatProbeDetails: (probe) => [probe.phase, ...(probe.models ?? [])].filter(Boolean),
  }));
  assert.match(html, /<h1[^>]*>AI control plane<\/h1>/);
  assert.match(html, /Connections/);
  assert.match(html, /Primary provider/);
  assert.match(html, /client\.assistant_message/);
  assert.match(html, /invocation/);
  assert.match(html, /fast-model/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /api\/admin|maint\.|AgentNovas|rc-/i);
});

test("renders injected unified usage without owning URLs, RBAC, translations, or styles", () => {
  const usage = {
    from: "2026-08-01",to: "2026-08-30",timezone: "UTC",includesProbeTraffic: false,
    summary: {
      requestCount: 2,attemptedCount: 3,succeededCount: 2,failedCount: 1,cancelledCount: 0,
      fallbackAttemptCount: 1,inputTokens: "20",outputTokens: "8",cachedInputTokens: "3",
      reasoningTokens: "2",unpricedCount: 2,providerLatencyP50Ms: 100,providerLatencyP95Ms: 200,
    },
    byConsumer: [],byRole: [],byDeployment: [],providerCosts: [],settledCredits: "0",
  };
  const html = renderToStaticMarkup(createElement(AiUsageManager,{
    client: { snapshot: async () => usage },initialSnapshot: usage,
    query: { from: usage.from,to: usage.to,includeProbeTraffic: false },
    messages: {
      title: "AI usage",refresh: "Refresh",loading: "Loading",error: "Error",empty: "Empty",
      requests: "Requests",attempts: "Attempts",tokens: "Tokens",fallbacks: "Fallbacks",
      unpriced: "Unpriced",consumers: "Consumers",roles: "Roles",deployments: "Deployments",
      includeProbes: "Include probes",providerCosts: "Provider costs",settledCredits: "Settled credits",
    },
    formatInteger: String,
  }));
  assert.match(html,/<h1[^>]*>AI usage<\/h1>/);
  assert.match(html,/Include probes/);
  assert.match(html,/Fallbacks/);
  assert.match(html,/Provider costs/);
  assert.doesNotMatch(html,/api\/|maint\.|AgentNovas|rc-/i);
});
