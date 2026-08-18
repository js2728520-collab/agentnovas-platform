import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchParameterVariants } from "../lib/research-parameter-search.ts";

const dsl = {
  schemaVersion: 3,
  name: "多指标参数测试",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: {
    long: {
      entry: { all: [
        { type: "ema_cross", fastPeriod: 20, slowPeriod: 50, direction: "bullish" },
        { type: "rsi_threshold", period: 14, operator: "lte", value: 35 },
        { type: "channel_breakout", period: 20, direction: "above" },
        { type: "volume_ratio", period: 20, operator: "gte", value: 1.2 },
      ] },
      exit: { any: [
        { type: "adx_threshold", period: 14, operator: "lte", value: 18 },
        { type: "bollinger_band", period: 20, stdDev: 2, band: "upper", operator: "above" },
        { type: "atr_volatility", period: 14, operator: "gte", valuePct: 1.5 },
      ] },
      stopLossPct: 2,
      takeProfitPct: 4,
    },
  },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

test("produces bounded deterministic variants across every whitelisted parameter family", () => {
  const first = buildResearchParameterVariants(dsl, "deep", "candidate-a");
  const repeated = buildResearchParameterVariants(dsl, "deep", "candidate-a");
  const otherSeed = buildResearchParameterVariants(dsl, "deep", "candidate-b");

  assert.equal(first.length, 5);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, otherSeed);
  assert.deepEqual(first[0], dsl);
  const changed = JSON.stringify(first.slice(1));
  for (const field of ["fastPeriod", "slowPeriod", "value", "period", "stdDev", "valuePct", "stopLossPct", "takeProfitPct"]) {
    assert.ok(changed.includes(field));
  }
  for (const variant of first) {
    const leg = variant.legs.long;
    const ema = leg.entry.all[0];
    assert.ok(ema.fastPeriod < ema.slowPeriod);
    assert.ok(leg.stopLossPct < variant.risk.maxDrawdownPct);
  }
});

test("keeps quick and standard search within their backtest budget", () => {
  assert.equal(buildResearchParameterVariants(dsl, "quick", "seed").length, 2);
  assert.equal(buildResearchParameterVariants(dsl, "standard", "seed").length, 2);
});
