import assert from "node:assert/strict";
import test from "node:test";

import {
  StrategyDslValidationError,
  evaluateStrategyEntryAt,
  normalizeStrategyDsl,
  strategyDslFromBrief,
} from "../packages/domain/src/strategy-dsl.ts";

const validDsl = {
  schemaVersion: 1,
  name: "BTC 趋势确认",
  symbol: "BTC/USDT",
  timeframe: "1H",
  side: "long_only",
  entry: {
    all: [
      { type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" },
      { type: "volume_ratio", period: 20, operator: "gte", value: 1.2 },
    ],
  },
  exit: {
    any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }],
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

test("normalizes a valid V1 strategy DSL without preserving unknown input shapes", () => {
  const normalized = normalizeStrategyDsl(validDsl);

  assert.equal(normalized.symbol, "BTCUSDT");
  assert.equal(normalized.timeframe, "1h");
  assert.equal(normalized.entry.all.length, 2);
  assert.equal(normalized.risk.positionPct, 3);
});

test("rejects unsupported fields, code-like rules, invalid periods, and unsafe risk", () => {
  assert.throws(
    () => normalizeStrategyDsl({ ...validDsl, python: "buy()" }),
    (error) => error instanceof StrategyDslValidationError && error.issues.some((issue) => issue.path === "python"),
  );
  assert.throws(
    () => normalizeStrategyDsl({
      ...validDsl,
      entry: { all: [{ type: "python", source: "return True" }] },
    }),
    StrategyDslValidationError,
  );
  assert.throws(
    () => normalizeStrategyDsl({
      ...validDsl,
      entry: { all: [{ type: "ema_cross", fastPeriod: 60, slowPeriod: 20, direction: "bullish" }] },
    }),
    /快线周期必须小于慢线周期/,
  );
  assert.throws(
    () => normalizeStrategyDsl({
      ...validDsl,
      risk: { ...validDsl.risk, positionPct: 31 },
    }),
    /单次资金占比/,
  );
});

test("evaluates allowlisted channel and volume conditions deterministically", () => {
  const dsl = normalizeStrategyDsl({
    ...validDsl,
    entry: {
      all: [
        { type: "channel_breakout", period: 3, direction: "above" },
        { type: "volume_ratio", period: 3, operator: "gte", value: 1.5 },
      ],
    },
  });
  const candles = [
    [10, 11, 9, 10, 10],
    [10, 12, 9, 11, 10],
    [11, 13, 10, 12, 10],
    [12, 15, 11, 14, 20],
  ].map(([open, high, low, close, volume], index) => ({
    openTime: index * 60_000,
    closeTime: (index + 1) * 60_000 - 1,
    open,
    high,
    low,
    close,
    volume,
  }));

  assert.equal(evaluateStrategyEntryAt(dsl, candles, 2), false);
  assert.equal(evaluateStrategyEntryAt(dsl, candles, 3), true);
});

test("builds a conservative allowlisted fallback DSL from a strategy brief", () => {
  const generated = strategyDslFromBrief({
    name: "SOL 突破研究",
    symbol: "SOL/USDT",
    period: "15m",
    style: "突破动量",
    capital: "5",
    stopLoss: "2",
    takeProfit: "4",
    maxDrawdown: "12",
  });

  assert.equal(generated.symbol, "SOLUSDT");
  assert.equal(generated.timeframe, "15m");
  assert.deepEqual(generated.entry.all.map((rule) => rule.type), ["channel_breakout", "volume_ratio"]);
  assert.equal(generated.side, "long_only");
});
