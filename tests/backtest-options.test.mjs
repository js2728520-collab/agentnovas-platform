import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeBacktestOptions } from "../lib/backtest-engine.ts";

test("normalizes live-aligned and exploration backtest presets", () => {
  assert.deepEqual(normalizeBacktestOptions(), {
    preset: "live_aligned",
    feeRate: 0.001,
    slippageRate: 0.0005,
    initialEquityUsdt: 10_000,
    candleLimit: 1_000,
  });
  assert.deepEqual(normalizeBacktestOptions({ preset: "exploration", feeRate: 0.002, candleLimit: 500 }), {
    preset: "exploration",
    feeRate: 0.002,
    slippageRate: 0,
    initialEquityUsdt: 10_000,
    candleLimit: 500,
  });
});

test("rejects backtest parameters outside platform safety and data limits", () => {
  assert.throws(() => normalizeBacktestOptions({ initialEquityUsdt: 99 }), /初始资金/);
  assert.throws(() => normalizeBacktestOptions({ feeRate: 0.011 }), /手续费/);
  assert.throws(() => normalizeBacktestOptions({ slippageRate: -0.001 }), /滑点/);
  assert.throws(() => normalizeBacktestOptions({ feeRate: "0.001" }), /手续费.*数字/);
  assert.throws(() => normalizeBacktestOptions({ candleLimit: 1_001 }), /K线/);
  assert.throws(() => normalizeBacktestOptions({ preset: "optimistic" }), /回测预设/);
});

test("strategy detail and backtest routes enforce ownership and persist parsed reports", async () => {
  const [detailRoute, backtestRoute] = await Promise.all([
    readFile(new URL("../app/api/strategy-marketplace/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategy-marketplace/[id]/backtest/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(detailRoute, /export async function GET/);
  assert.match(detailRoute, /strategyVersions/);
  assert.match(detailRoute, /strategyBacktestReports/);
  assert.match(detailRoute, /authorUserId/);
  assert.match(detailRoute, /metricsJson/);
  assert.match(backtestRoute, /request\.json/);
  assert.match(backtestRoute, /normalizeBacktestOptions/);
  assert.match(backtestRoute, /runHistoricalBacktest\([\s\S]*options/);
});
