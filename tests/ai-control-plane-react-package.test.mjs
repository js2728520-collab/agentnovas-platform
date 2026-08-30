import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AiControlPlaneManager } from "../packages/ai-control-plane-react/dist/index.js";

const snapshot = {
  connections: [{
    id: "connection-1", name: "Primary provider", adapterId: "openai-compatible", enabled: true,
    currentRevisionId: "connection-revision-1", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
  }],
  deployments: [{ id: "deployment-1", name: "Fast model", connectionId: "connection-1", enabled: true, currentRevisionId: "deployment-revision-1" }],
  bindings: [{
    id: "binding-1", roleKey: "client.assistant_message", revisionId: "binding-revision-1", enabled: true,
    targets: [{ deploymentId: "deployment-1", priority: 0 }],
  }],
  probes: [{
    id: "probe-1", configurationFingerprint: "a".repeat(64), status: "succeeded",
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
  bindings: "Bindings",
  probes: "Probe history",
  budgets: "Budgets",
  enabled: "Enabled",
  disabled: "Disabled",
  primary: "Primary",
  fallback: "Fallback",
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
  }));
  assert.match(html, /<h1[^>]*>AI control plane<\/h1>/);
  assert.match(html, /Connections/);
  assert.match(html, /Primary provider/);
  assert.match(html, /client\.assistant_message/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /api\/admin|maint\.|AgentNovas|rc-/i);
});
