import assert from "node:assert/strict";
import test from "node:test";

import {
  listMaintenanceSourceIntegrations,
  runMaintenanceSourceIntegrationCheck,
} from "../lib/maintenance-integration-catalog.ts";

test("maintenance source catalog separates configured, health, stale, and secret state", async () => {
  const now = new Date("2026-08-21T10:00:00.000Z");
  const pool = {
    async query() {
      return {
        rows: [{
          subject_id: "binance-public-market",
          after_json: { status: "succeeded", errorCode: null, latencyMs: 42 },
          created_at: new Date("2026-08-21T09:59:00.000Z"),
        }],
      };
    },
  };
  const catalog = await listMaintenanceSourceIntegrations(pool, { COINGECKO_API_KEY: "secret-value" }, now);
  const binance = catalog.find((item) => item.id === "binance-public-market");
  const coinGecko = catalog.find((item) => item.id === "coingecko");
  assert.equal(binance.configured, true);
  assert.equal(binance.health, "healthy");
  assert.equal(binance.lastLatencyMs, 42);
  assert.equal(coinGecko.configured, true);
  assert.equal(coinGecko.hasSecret, true);
  assert.equal(coinGecko.health, "untested");
  assert.equal(JSON.stringify(catalog).includes("secret-value"), false);
  assert.equal(JSON.stringify(catalog).includes("https://"), false);
});

test("maintenance source check only calls its code-fixed public endpoint and records safe evidence", async () => {
  const writes = [];
  const pool = { async query(sql, params) { writes.push({ sql, params }); return { rows: [] }; } };
  const requested = [];
  const result = await runMaintenanceSourceIntegrationCheck(pool, {
    id: "binance-public-market",
    actorUserId: "maint-1",
    reason: "发布前只读连通检查",
    now: new Date("2026-08-21T10:00:00.000Z"),
    async fetchImplementation(url, options) {
      requested.push({ url, options });
      return new Response(JSON.stringify({ serverTime: 123 }), { status: 200 });
    },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requested.map((entry) => entry.url), ["https://data-api.binance.vision/api/v3/time"]);
  assert.equal(requested[0].options.redirect, "error");
  assert.equal(writes.length, 1);
  const persisted = JSON.parse(writes[0].params[3]);
  assert.deepEqual(Object.keys(persisted).sort(), ["errorCode", "latencyMs", "reason", "status"]);
  assert.equal(JSON.stringify(writes).includes("data-api.binance.vision"), false);
});

test("source catalog exposes server-only configuration entry points without secrets", async () => {
  const pool = { async query() { return { rows: [] }; } };
  const catalog = await listMaintenanceSourceIntegrations(pool, {}, new Date("2026-08-21T10:00:00.000Z"));
  const binance = catalog.find((item) => item.id === "binance-public-market");
  const coinGecko = catalog.find((item) => item.id === "coingecko");
  assert.deepEqual(binance.configurationEnvKeys, ["MARKET_DATA_BASE_URL", "MARKET_DATA_PROVIDER"]);
  assert.deepEqual(binance.missingEnvKeys, binance.configurationEnvKeys);
  assert.equal(binance.configurationMethod, "server_environment");
  assert.deepEqual(coinGecko.configurationEnvKeys, ["COINGECKO_API_KEY"]);
  assert.deepEqual(coinGecko.missingEnvKeys, ["COINGECKO_API_KEY"]);
  assert.equal(JSON.stringify(catalog).includes("secret-value"), false);
});

test("maintenance source check rejects unknown and browser-controlled targets", async () => {
  const pool = { async query() { throw new Error("must not write"); } };
  await assert.rejects(runMaintenanceSourceIntegrationCheck(pool, {
    id: "https://127.0.0.1/internal",
    actorUserId: "maint-1",
    reason: "安全测试",
    async fetchImplementation() { throw new Error("must not fetch"); },
  }), /INTEGRATION_NOT_FOUND/);
});
