import assert from "node:assert/strict";
import test from "node:test";

import {
  StrategyDslValidationError,
  normalizeStrategyDslV2,
  strategyDslToRuntime,
} from "../lib/strategy-dsl.ts";

const longLeg = {
  entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
  exit: { any: [{ type: "rsi_threshold", period: 14, operator: "gte", value: 70 }] },
  stopLossPct: 2,
  takeProfitPct: 4,
};

const shortLeg = {
  entry: {
    all: [
      { type: "channel_breakout", period: 20, direction: "below" },
      { type: "adx_threshold", period: 14, operator: "gte", value: 20 },
      { type: "atr_volatility", period: 14, operator: "lte", valuePct: 5 },
    ],
  },
  exit: {
    any: [{ type: "bollinger_band", period: 20, stdDev: 2, band: "lower", operator: "above" }],
  },
  stopLossPct: 2.5,
  takeProfitPct: 5,
};

const validV2 = {
  schemaVersion: 2,
  name: "BTC 双向永续研究",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTC/USDT",
  timeframe: "1H",
  direction: "both",
  legs: { long: longLeg, short: shortLeg },
  risk: {
    positionSizePct: 5,
    maxDrawdownPct: 12,
    maxDailyLossPct: 3,
    maxConsecutiveLosses: 3,
  },
};

test("normalizes a strict V2 perpetual strategy with independent long and short legs", () => {
  const normalized = normalizeStrategyDslV2(validV2);

  assert.equal(normalized.symbol, "BTCUSDT");
  assert.equal(normalized.timeframe, "1h");
  assert.equal(normalized.direction, "both");
  assert.equal(normalized.legs.long.stopLossPct, 2);
  assert.deepEqual(normalized.legs.short.entry.all.map((rule) => rule.type), [
    "channel_breakout",
    "adx_threshold",
    "atr_volatility",
  ]);
});

test("rejects unsupported V2 fields, arbitrary code, unsafe leverage, and incomplete both legs", () => {
  assert.throws(
    () => normalizeStrategyDslV2({ ...validV2, script: "return buy()" }),
    (error) => error instanceof StrategyDslValidationError
      && error.issues.some((issue) => issue.path === "script"),
  );
  assert.throws(() => normalizeStrategyDslV2({ ...validV2, leverage: 2 }), /leverage.*1/);
  assert.throws(
    () => normalizeStrategyDslV2({ ...validV2, legs: { long: longLeg } }),
    /legs\.short/,
  );
  assert.throws(
    () => normalizeStrategyDslV2({
      ...validV2,
      legs: {
        ...validV2.legs,
        short: { ...shortLeg, entry: { all: [{ type: "javascript", source: "buy()" }] } },
      },
    }),
    /不支持的策略规则/,
  );
});

test("maps V1 to a V2 long-only runtime without rewriting the stored V1 object", () => {
  const v1 = {
    schemaVersion: 1,
    name: "兼容策略",
    symbol: "ETHUSDT",
    timeframe: "4h",
    side: "long_only",
    entry: { all: [{ type: "rsi_threshold", period: 14, operator: "lte", value: 30 }] },
    exit: {
      any: [{ type: "rsi_threshold", period: 14, operator: "gte", value: 60 }],
      stopLossPct: 2,
      takeProfitPct: 4,
    },
    risk: {
      positionPct: 3,
      maxDrawdownPct: 10,
      dailyLossLimitPct: 2,
      consecutiveLossLimit: 3,
    },
  };

  const runtime = strategyDslToRuntime(v1);

  assert.equal(runtime.schemaVersion, 2);
  assert.equal(runtime.direction, "long_only");
  assert.equal(runtime.legs.long.entry.all[0].type, "rsi_threshold");
  assert.equal(runtime.risk.positionSizePct, 3);
  assert.equal(v1.schemaVersion, 1);
  assert.equal("legs" in v1, false);
});

