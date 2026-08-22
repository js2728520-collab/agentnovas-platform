import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { cachePerpetualMarketData, loadCachedPerpetualMarketData } from "../lib/postgres-market-cache.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `market_cache_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migration = await readFile(new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url), "utf8");
  await pool.query(migration);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE market_candles, funding_rates");
});

test("upserts deduplicated candles and funding rates and reloads them in chronological order", async () => {
  await cachePerpetualMarketData(pool, {
    exchange: "okx",
    symbol: "BTCUSDT",
    timeframe: "1h",
    candles: [
      { openTime: 200, closeTime: 299, open: 2, high: 3, low: 1, close: 2.5, volume: 20 },
      { openTime: 100, closeTime: 199, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { openTime: 200, closeTime: 299, open: 2, high: 4, low: 1, close: 3, volume: 25 },
    ],
    fundingRates: [
      { time: 200, rate: 0.0002 },
      { time: 100, rate: 0.0001 },
      { time: 200, rate: 0.0003 },
    ],
  });

  const loaded = await loadCachedPerpetualMarketData(pool, {
    exchange: "okx",
    symbol: "BTCUSDT",
    timeframe: "1h",
    startTime: 0,
    endTime: 1_000,
  });

  assert.deepEqual(loaded.candles.map((item) => item.openTime), [100, 200]);
  assert.equal(loaded.candles[1].close, 3);
  assert.deepEqual(loaded.fundingRates.map((item) => item.time), [100, 200]);
  assert.equal(loaded.fundingRates[1].rate, 0.0003);
});
