import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createMarketInstrumentsPayload,
  marketCatalog,
  marketCatalogInstruments,
} from "../lib/market-catalog.ts";
import { marketInstruments } from "../lib/market-instruments.ts";

test("keeps reusable market data outside the Next route module", () => {
  const routeSource = readFileSync(new URL("../app/api/market/instruments/route.client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /export\s+(?:const|function|class|type|interface)\s+(?!GET\b)/);
  assert.ok(marketInstruments.length > 0);
  assert.equal(marketInstruments.find((item) => item.symbol === "BTCUSD")?.providerSymbol, "BTCUSDT");
});

test("adds a versioned current-market catalog without changing legacy instrument fields", () => {
  const payload = createMarketInstrumentsPayload("2026-08-24T01:02:03Z");
  const bitcoin = payload.instruments.find((item) => item.symbol === "BTCUSD");

  assert.equal(payload.contractVersion, 1);
  assert.equal(payload.updatedAt, "2026-08-24T01:02:03.000Z");
  assert.equal(payload.source, "Riverton Capital market catalog");
  assert.equal(payload.instruments.length, marketInstruments.length);
  assert.deepEqual(
    {
      symbol: bitcoin?.symbol,
      label: bitcoin?.label,
      name: bitcoin?.name,
      nameZh: bitcoin?.nameZh,
      category: bitcoin?.category,
      providerSymbol: bitcoin?.providerSymbol,
      aliases: bitcoin?.aliases,
    },
    marketInstruments.find((item) => item.symbol === "BTCUSD"),
  );
  assert.equal(bitcoin?.id, "crypto-btc-usd");
  assert.equal(bitcoin?.marketId, "crypto-global");
  assert.deepEqual(bitcoin?.providerMappings, [
    { providerId: "public-binance-market-data", providerSymbol: "BTCUSDT" },
  ]);
});

test("catalogs only markets available today and never claims streaming or execution capability", () => {
  assert.deepEqual(marketCatalog.map((item) => item.id), [
    "crypto-global",
    "equities-us",
    "forex-global",
    "metals-global",
  ]);
  assert.equal(marketCatalog.some((item) => ["cn", "hk", "kr", "jp"].includes(item.region)), false);
  assert.equal(marketCatalog.some((item) => item.capabilities.includes("realtime_stream")), false);
  assert.equal(marketCatalog.some((item) => item.usage.includes("execution")), false);
  assert.equal(marketCatalog.every((item) => item.executionPolicy === "display_only"), true);
});

test("keeps canonical instruments and public provider mappings unique and internally consistent", () => {
  const marketIds = new Set(marketCatalog.map((item) => item.id));
  const instrumentIds = marketCatalogInstruments.map((item) => item.id);
  const providerMappings = marketCatalogInstruments.flatMap((item) =>
    item.providerMappings.map((mapping) => `${mapping.providerId}:${mapping.providerSymbol}`),
  );

  assert.equal(new Set(instrumentIds).size, instrumentIds.length);
  assert.equal(new Set(providerMappings).size, providerMappings.length);
  assert.equal(marketCatalogInstruments.every((item) => marketIds.has(item.marketId)), true);
  assert.equal(
    marketCatalogInstruments.every((item) => item.providerMappings.every((mapping) => mapping.providerId.startsWith("public-"))),
    true,
  );
});

test("the Next route delegates to the catalog payload without provider-specific branches", () => {
  const routeSource = readFileSync(new URL("../app/api/market/instruments/route.client.ts", import.meta.url), "utf8");
  assert.match(routeSource, /createMarketInstrumentsPayload/);
  assert.doesNotMatch(routeSource, /binance|yahoo|coinbase/i);
  assert.match(routeSource, /cache-control["']:\s*["']no-store["']/);
});

test("catalog payload timestamps must be bounded UTC input", () => {
  assert.throws(() => createMarketInstrumentsPayload("2026-08-24T09:02:03+08:00"), /UTC timestamp/i);
  assert.throws(() => createMarketInstrumentsPayload(`${"1".repeat(200)}Z`), /UTC timestamp/i);
  assert.throws(() => createMarketInstrumentsPayload("not-a-timeZ"), /UTC timestamp/i);
});
