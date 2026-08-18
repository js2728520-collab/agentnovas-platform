import assert from "node:assert/strict";
import test from "node:test";

import { hashMarketDataSeries, saveMarketDataSnapshot } from "../lib/market-data-snapshots.ts";

const candles = [
  { openTime: 100, closeTime: 199, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { openTime: 200, closeTime: 299, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20 },
];
const fundingRates = [{ time: 150, rate: 0.0001 }];

test("market data hashes are deterministic and change with any candle value", async () => {
  const first = await hashMarketDataSeries(candles, fundingRates);
  const second = await hashMarketDataSeries(structuredClone(candles), structuredClone(fundingRates));
  const changed = await hashMarketDataSeries([{ ...candles[0], close: 1.6 }, candles[1]], fundingRates);

  assert.deepEqual(first, second);
  assert.notEqual(first.candleSha256, changed.candleSha256);
  assert.notEqual(first.datasetSha256, changed.datasetSha256);
  assert.match(first.datasetSha256, /^[a-f0-9]{64}$/);
});

test("persists an immutable research data snapshot with explicit JSONB parameters", async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /INSERT INTO market_data_snapshots/);
      assert.match(sql, /ON CONFLICT \(source_type, source_id\) DO NOTHING/);
      assert.equal(typeof values[15], "string");
      assert.equal(typeof values[16], "string");
      assert.equal(typeof values[17], "string");
      assert.deepEqual(JSON.parse(values[15]), { tickSize: 0.1, lotSize: 0.001 });
      return { rows: [{ id: values[0], dataset_sha256: values[14] }] };
    },
  };

  const snapshot = await saveMarketDataSnapshot(database, {
    sourceType: "research_run",
    sourceId: "run-a",
    exchangeAccountId: "account-a",
    exchange: "binance",
    instrumentId: "BTCUSDT",
    symbol: "BTCUSDT",
    timeframe: "1h",
    candles,
    fundingRates,
    instrumentRules: { tickSize: 0.1, lotSize: 0.001 },
    feeSchedule: { takerRate: 0.0005, source: "authenticated" },
    dataQuality: { isVerifiable: true },
  });

  assert.equal(snapshot.datasetSha256.length, 64);
});
