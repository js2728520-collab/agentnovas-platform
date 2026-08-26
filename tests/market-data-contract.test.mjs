import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKET_DATA_CONTRACT_VERSION,
  createMarketDataEventEnvelope,
  evaluateMarketDataFreshness,
  normalizeMarketDescriptor,
  normalizeProviderDescriptor,
} from "../packages/contracts/src/market-data.ts";

const market = {
  id: "crypto-global",
  assetClass: "crypto",
  region: "global",
  timezone: "UTC",
  calendar: { id: "crypto-24-7", kind: "continuous" },
  capabilities: ["quote_snapshot", "candle_history", "realtime_stream"],
  protocols: ["rest", "websocket"],
  usage: ["display", "research"],
  executionPolicy: "display_only",
};

test("normalizes a provider-independent market descriptor", () => {
  assert.deepEqual(normalizeMarketDescriptor(market), {
    ...market,
    capabilities: ["candle_history", "quote_snapshot", "realtime_stream"],
    protocols: ["rest", "websocket"],
    usage: ["display", "research"],
  });
});

test("rejects unknown market fields, duplicate capabilities, and invalid IANA timezones", () => {
  assert.throws(() => normalizeMarketDescriptor({ ...market, provider: "binance" }), /unknown field/i);
  assert.throws(
    () => normalizeMarketDescriptor({ ...market, capabilities: ["quote_snapshot", "quote_snapshot"] }),
    /duplicate/i,
  );
  assert.throws(() => normalizeMarketDescriptor({ ...market, timezone: "EST" }), /IANA timezone/i);
});

test("keeps provider authorization, runtime state, and declared targets separate", () => {
  const provider = normalizeProviderDescriptor({
    id: "public-binance-market-data",
    name: "Public Binance market data",
    authorization: "public",
    marketIds: ["crypto-global"],
    capabilities: ["quote_snapshot", "candle_history"],
    protocols: ["rest"],
    usage: ["display", "research"],
    configured: false,
    connection: "disconnected",
    health: "unknown",
    latencyTargetMs: 500,
    reconnectTargetMs: 10_000,
    staleAfterMs: 30_000,
  });

  assert.equal(provider.authorization, "public");
  assert.equal(provider.configured, false);
  assert.equal(provider.connection, "disconnected");
  assert.equal(provider.health, "unknown");
  assert.deepEqual(provider.usage, ["display", "research"]);
  assert.equal(provider.usage.includes("execution"), false);
});

test("rejects invalid provider identifiers, target thresholds, and browser-supplied eligibility", () => {
  const provider = {
    id: "Binance Public",
    name: "Public source",
    authorization: "public",
    marketIds: ["crypto-global"],
    capabilities: ["quote_snapshot"],
    protocols: ["rest"],
    usage: ["display"],
    configured: false,
    connection: "disconnected",
    health: "unknown",
    latencyTargetMs: 500,
    reconnectTargetMs: 10_000,
    staleAfterMs: 30_000,
  };

  assert.throws(() => normalizeProviderDescriptor(provider), /provider id/i);
  assert.throws(
    () => normalizeProviderDescriptor({ ...provider, id: "binance-public", staleAfterMs: 400 }),
    /stale.*latency/i,
  );
  assert.throws(
    () => normalizeProviderDescriptor({ ...provider, id: "binance-public", canOpenPosition: true }),
    /unknown field/i,
  );
});

test("derives fresh, delayed, and stale quality at exact boundaries", () => {
  const input = {
    exchangeAt: "2026-08-24T00:00:00.000Z",
    receivedAt: "2026-08-24T00:00:00.500Z",
    evaluatedAt: "2026-08-24T00:00:01.000Z",
    latencyTargetMs: 500,
    staleAfterMs: 30_000,
  };

  assert.deepEqual(evaluateMarketDataFreshness(input), {
    latencyMs: 500,
    quality: "fresh",
    canOpenPosition: true,
  });
  assert.deepEqual(
    evaluateMarketDataFreshness({ ...input, receivedAt: "2026-08-24T00:00:00.501Z" }),
    { latencyMs: 501, quality: "delayed", canOpenPosition: false },
  );
  assert.deepEqual(
    evaluateMarketDataFreshness({ ...input, evaluatedAt: "2026-08-24T00:00:30.000Z" }),
    { latencyMs: 500, quality: "stale", canOpenPosition: false },
  );
});

test("fails closed for invalid timestamps, excessive clock skew, and invalid thresholds", () => {
  const input = {
    exchangeAt: "2026-08-24T00:00:00.000Z",
    receivedAt: "2026-08-24T00:00:00.100Z",
    evaluatedAt: "2026-08-24T00:00:00.200Z",
    latencyTargetMs: 500,
    staleAfterMs: 30_000,
  };

  assert.deepEqual(evaluateMarketDataFreshness({ ...input, exchangeAt: "not-a-time" }), {
    latencyMs: null,
    quality: "invalid",
    canOpenPosition: false,
  });
  assert.deepEqual(
    evaluateMarketDataFreshness({ ...input, receivedAt: "2026-08-23T23:59:54.999Z" }),
    { latencyMs: null, quality: "invalid", canOpenPosition: false },
  );
  assert.deepEqual(evaluateMarketDataFreshness({ ...input, staleAfterMs: 500 }), {
    latencyMs: null,
    quality: "invalid",
    canOpenPosition: false,
  });
  assert.deepEqual(
    evaluateMarketDataFreshness({
      ...input,
      receivedAt: "2026-08-24T00:00:00.201Z",
      evaluatedAt: "2026-08-24T00:00:00.200Z",
    }),
    { latencyMs: null, quality: "invalid", canOpenPosition: false },
  );
});

test("creates a versioned event envelope and derives eligibility on the server", () => {
  const event = createMarketDataEventEnvelope({
    providerId: "public-binance-market-data",
    marketId: "crypto-global",
    instrumentId: "crypto-btc-usd",
    sequence: "9007199254740993",
    exchangeAt: "2026-08-24T00:00:00Z",
    receivedAt: "2026-08-24T00:00:00.250Z",
    evaluatedAt: "2026-08-24T00:00:01Z",
    latencyTargetMs: 500,
    staleAfterMs: 30_000,
  });

  assert.deepEqual(event, {
    contractVersion: MARKET_DATA_CONTRACT_VERSION,
    providerId: "public-binance-market-data",
    marketId: "crypto-global",
    instrumentId: "crypto-btc-usd",
    sequence: "9007199254740993",
    exchangeAt: "2026-08-24T00:00:00.000Z",
    receivedAt: "2026-08-24T00:00:00.250Z",
    evaluatedAt: "2026-08-24T00:00:01.000Z",
    latencyMs: 250,
    quality: "fresh",
    canOpenPosition: true,
  });
});

test("rejects malformed sequences and client-provided event quality fields", () => {
  const input = {
    providerId: "public-binance-market-data",
    marketId: "crypto-global",
    instrumentId: "crypto-btc-usd",
    sequence: "01",
    exchangeAt: "2026-08-24T00:00:00Z",
    receivedAt: "2026-08-24T00:00:00.250Z",
    evaluatedAt: "2026-08-24T00:00:01Z",
    latencyTargetMs: 500,
    staleAfterMs: 30_000,
  };

  assert.throws(() => createMarketDataEventEnvelope(input), /sequence/i);
  assert.throws(
    () => createMarketDataEventEnvelope({ ...input, sequence: "1", quality: "fresh" }),
    /unknown field/i,
  );
});

test("bounds identifier, array, timezone, and sequence work at the contract boundary", () => {
  assert.throws(() => normalizeMarketDescriptor({ ...market, id: `market-${"a".repeat(90)}` }), /market id/i);
  assert.throws(
    () => normalizeMarketDescriptor({ ...market, capabilities: Array(10_000).fill("quote_snapshot") }),
    /capabilities.*too many/i,
  );
  assert.throws(() => normalizeMarketDescriptor({ ...market, timezone: `Area/${"a".repeat(90)}` }), /IANA timezone/i);
  assert.throws(
    () => createMarketDataEventEnvelope({
      providerId: "public-binance-market-data",
      marketId: "crypto-global",
      instrumentId: "crypto-btc-usd",
      sequence: "9".repeat(1_000),
      exchangeAt: "2026-08-24T00:00:00Z",
      receivedAt: "2026-08-24T00:00:00.250Z",
      evaluatedAt: "2026-08-24T00:00:01Z",
      latencyTargetMs: 500,
      staleAfterMs: 30_000,
    }),
    /sequence/i,
  );
});
