import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clientDemoProviderCatalog,
} from "../packages/contracts/src/commercial-beta.ts";
import {
  loadClientDemoSummary,
} from "../lib/client-demo-summary.ts";

function databaseWith({ accounts = [], evidence = [] } = {}) {
  return {
    async query(text) {
      if (text.includes("FROM platform_demo_accounts_safe")) return { rows: accounts };
      if (text.includes("FROM platform_demo_order_intents")) return { rows: evidence };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

function forbiddenKeys(value, path = "response") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const current = `${path}.${key}`;
    const forbidden = /secret|cipher|api.?key|passphrase|endpoint|payload|order.?id|account.?id|trace.?id/i.test(key)
      ? [current]
      : [];
    return [...forbidden, ...forbiddenKeys(nested, current)];
  });
}

test("Client Demo summary always returns the fixed provider/card catalog without platform-account details", async () => {
  const summary = await loadClientDemoSummary(databaseWith());

  assert.equal(summary.customerImpact, false);
  assert.equal(summary.demoFailureAffectsPaper, false);
  assert.deepEqual(summary.providers.map(({ provider, environment, status }) => ({ provider, environment, status })), [
    { provider: "OKX", environment: "OKX_DEMO", status: "NOT_CONFIGURED" },
    { provider: "BINANCE", environment: "BINANCE_SPOT_TESTNET", status: "NOT_CONFIGURED" },
    { provider: "BYBIT", environment: "BYBIT_DEMO", status: "NOT_CONFIGURED" },
  ]);
  assert.deepEqual(summary.providers.map((provider) => provider.cards.map((card) => card.strategyCode)), [
    ["ai_conservative", "ai_balanced", "ai_aggressive"],
    ["ai_conservative", "ai_balanced", "ai_aggressive"],
    ["ai_conservative", "ai_balanced", "ai_aggressive"],
  ]);
  assert.deepEqual(forbiddenKeys(summary), []);
});

test("Client Demo summary exposes only latest sanitized evidence and keeps failures isolated from Paper", async () => {
  const summary = await loadClientDemoSummary(databaseWith({
    accounts: [{
      provider: "okx",
      enabled: true,
      kill_switch_enabled: false,
      last_verified_at: new Date("2026-08-21T01:00:00.000Z"),
      last_verification_status: "passed",
      api_key_ciphertext: "must-not-leak",
      secret_ciphertext: "must-not-leak",
      endpoint: "https://must-not-leak.example",
    }],
    evidence: [{
      provider: "okx",
      strategy_code: "ai_balanced",
      execution_status: "failed",
      last_tested_at: new Date("2026-08-21T02:00:00.000Z"),
      receipt_status: "rejected",
      receipt_observed_at: new Date("2026-08-21T01:59:00.000Z"),
      provider_order_id: "must-not-leak",
      client_order_id: "must-not-leak",
      safe_summary_json: { raw: "must-not-leak" },
    }],
  }));

  const okx = summary.providers[0];
  assert.equal(okx.status, "VERIFIED");
  assert.equal(okx.lastTestedAt, "2026-08-21T02:00:00.000Z");
  assert.deepEqual(okx.cards[1], {
    strategyCode: "ai_balanced",
    status: "FAILED",
    lastTestedAt: "2026-08-21T02:00:00.000Z",
    receiptSummary: {
      status: "REJECTED",
      observedAt: "2026-08-21T01:59:00.000Z",
    },
  });
  assert.equal(summary.customerImpact, false);
  assert.equal(summary.demoFailureAffectsPaper, false);
  assert.deepEqual(forbiddenKeys(summary), []);
});

test("Client Demo summary reports provider and card pauses without claiming connectivity", async () => {
  const summary = await loadClientDemoSummary(databaseWith({
    accounts: [{
      provider: "binance",
      enabled: true,
      kill_switch_enabled: false,
      last_verified_at: null,
      last_verification_status: null,
    }, {
      provider: "bybit",
      enabled: true,
      kill_switch_enabled: true,
      last_verified_at: new Date("2026-08-21T03:00:00.000Z"),
      last_verification_status: "passed",
    }],
    evidence: [{
      provider: "binance",
      strategy_code: "ai_conservative",
      execution_status: "reconcile_wait",
      last_tested_at: new Date("2026-08-21T04:00:00.000Z"),
      receipt_status: null,
      receipt_observed_at: null,
    }],
  }));

  assert.equal(summary.providers[1].status, "UNVERIFIED");
  assert.equal(summary.providers[1].cards[0].status, "RECONCILE_WAIT");
  assert.equal(summary.providers[2].status, "PAUSED");
  assert.equal(summary.providers[2].cards.every((card) => card.status === "PAUSED"), true);
});

test("Client Demo summary never reports verified without a verification timestamp", async () => {
  const summary = await loadClientDemoSummary(databaseWith({
    accounts: [{
      provider: "okx",
      enabled: true,
      kill_switch_enabled: false,
      last_verified_at: null,
      last_verification_status: "passed",
    }],
  }));

  assert.equal(summary.providers[0].status, "UNVERIFIED");
  assert.equal(summary.providers[0].lastTestedAt, null);
});

test("Client Demo provider catalog is immutable product metadata", () => {
  assert.deepEqual(clientDemoProviderCatalog, [
    { provider: "OKX", environment: "OKX_DEMO" },
    { provider: "BINANCE", environment: "BINANCE_SPOT_TESTNET" },
    { provider: "BYBIT", environment: "BYBIT_DEMO" },
  ]);
});

test("Client Demo route is Client-only, permission-gated and does not query raw account credentials", async () => {
  const route = await readFile(
    new URL("../app/api/trading-hall/paper/platform-demo-summary/route.client.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /requireAccessPermission\(request,\s*["']client\.paper\.view["']\)/);
  assert.match(route, /loadClientDemoSummary/);
  assert.match(route, /cache-control["']:\s*["']no-store["']/);
  assert.doesNotMatch(route, /platform_demo_accounts\b/);
  assert.doesNotMatch(route, /secret|ciphertext|passphrase|endpoint|payload|provider_order_id|client_order_id/i);
});
