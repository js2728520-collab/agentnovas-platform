import assert from "node:assert/strict";
import test from "node:test";

import { runBacktestOnCandles } from "../packages/domain/src/backtest-engine.ts";

function candle(index, close, volume = 100) {
  return {
    openTime: index * 60_000,
    closeTime: (index + 1) * 60_000 - 1,
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume,
  };
}

const shared = {
  schemaVersion: 1,
  name: "DSL 回测测试",
  symbol: "BTCUSDT",
  timeframe: "1h",
  side: "long_only",
  exit: { any: [], stopLossPct: 2, takeProfitPct: 4 },
  risk: {
    positionPct: 3,
    maxDrawdownPct: 10,
    dailyLossLimitPct: 2,
    consecutiveLossLimit: 3,
  },
};

test("historical backtest executes the supplied DSL instead of a fixed style", async () => {
  const candles = Array.from({ length: 220 }, (_, index) => candle(index, 100 + (index % 2) * 0.1));
  candles[210] = candle(210, 104, 220);
  candles[211] = candle(211, 109, 180);

  const breakout = {
    ...shared,
    entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
  };
  const oversold = {
    ...shared,
    entry: { all: [{ type: "rsi_threshold", period: 14, operator: "lte", value: 10 }] },
  };

  const breakoutResult = await runBacktestOnCandles(breakout, candles);
  const oversoldResult = await runBacktestOnCandles(oversold, candles);

  assert.ok(breakoutResult.sampleSize >= 1);
  assert.equal(oversoldResult.sampleSize, 0);
  assert.equal(breakoutResult.engineVersion, "2.0.0-dsl-v1");
  assert.equal(breakoutResult.parameters.schemaVersion, 1);
  assert.match(breakoutResult.evidenceRef, /^sha256:[a-f0-9]{64}$/);
});

test("historical backtest rejects unvalidated executable-looking specifications", async () => {
  const candles = Array.from({ length: 220 }, (_, index) => candle(index, 100));
  await assert.rejects(
    runBacktestOnCandles({ ...shared, entry: { all: [{ type: "javascript", source: "return true" }] } }, candles),
    /不支持的策略规则/,
  );
});
