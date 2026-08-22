import assert from "node:assert/strict";
import test from "node:test";

import {
  createStrategyLegEvaluator,
  normalizeStrategyDslV3,
  strategyDslToRuntime,
} from "../packages/domain/src/strategy-dsl.ts";

const validV3 = {
  schemaVersion: 3,
  name: "BTC V3 条件树",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: {
    long: {
      entry: {
        all: [
          { type: "ema_alignment", periods: [5, 10, 20], direction: "bullish" },
          { type: "price_ema", period: 10, operator: "above" },
          { any: [
            { type: "momentum", period: 3, operator: "gte", valuePct: 0.1 },
            { not: { type: "candle_direction", direction: "bearish" } },
          ] },
        ],
      },
      exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
      stopLossPct: 2,
      takeProfitPct: 4,
    },
  },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

test("normalizes bounded V3 all/any/not trees and deterministic platform rules", () => {
  const normalized = normalizeStrategyDslV3(validV3);
  assert.equal(normalized.schemaVersion, 3);
  assert.equal(normalized.legs.long.entry.all[0].type, "ema_alignment");
  assert.equal(normalized.legs.long.entry.all[2].any[1].not.type, "candle_direction");
});

test("rejects arbitrary code, excessive depth, and excessive condition nodes", () => {
  assert.throws(() => normalizeStrategyDslV3({ ...validV3, code: "buy()" }), /不支持的字段/);
  const tooDeep = { not: { not: { not: { not: { not: { type: "candle_direction", direction: "bullish" } } } } } };
  assert.throws(() => normalizeStrategyDslV3({
    ...validV3,
    legs: { long: { ...validV3.legs.long, entry: tooDeep } },
  }), /深度/);
  assert.throws(() => normalizeStrategyDslV3({
    ...validV3,
    legs: { long: { ...validV3.legs.long, entry: { all: Array.from({ length: 33 }, () => ({ type: "candle_direction", direction: "bullish" })) } } },
  }), /节点|数量/);
});

test("uses the same V3 condition evaluator for deterministic candle signals", () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.8 + index,
    volume: 100,
  }));
  const runtime = strategyDslToRuntime(validV3);
  const evaluator = createStrategyLegEvaluator(runtime.legs.long, candles);
  assert.equal(evaluator.entryAt(30), true);
  assert.equal(evaluator.exitAt(30), false);
});

test("maps stored V1 and V2 strategies to V3 only at runtime", () => {
  const v2 = {
    ...validV3,
    schemaVersion: 2,
    legs: { long: {
      ...validV3.legs.long,
      entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
      exit: { any: [] },
    } },
  };
  const runtime = strategyDslToRuntime(v2);
  assert.equal(runtime.schemaVersion, 3);
  assert.equal(runtime.legs.long.entry.all[0].type, "channel_breakout");
  assert.equal(v2.schemaVersion, 2);
});
