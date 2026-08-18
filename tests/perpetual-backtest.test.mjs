import assert from "node:assert/strict";
import test from "node:test";

import { runPerpetualBacktestOnCandles } from "../lib/backtest-engine.ts";

function candle(index, { open = 100, high = open + 0.5, low = open - 0.5, close = open } = {}) {
  return {
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function shortBreakoutDsl(overrides = {}) {
  return {
    schemaVersion: 2,
    name: "BTC 空头突破",
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "short_only",
    legs: {
      short: {
        entry: { all: [{ type: "channel_breakout", period: 20, direction: "below" }] },
        exit: { any: [] },
        stopLossPct: 2,
        takeProfitPct: 4,
        ...overrides,
      },
    },
    risk: {
      positionSizePct: 10,
      maxDrawdownPct: 20,
      maxDailyLossPct: 10,
      maxConsecutiveLosses: 5,
    },
  };
}

function breakoutCandles(trigger, next) {
  const candles = Array.from({ length: 220 }, (_, index) => candle(index));
  candles[200] = candle(200, trigger);
  candles[201] = candle(201, next);
  return candles;
}

const costless = {
  preset: "exploration",
  feeRate: 0,
  slippageRate: 0,
  initialEquityUsdt: 10_000,
  candleLimit: 220,
};

test("confirms a short signal at close, enters at the next open, and takes profit from intrabar low", async () => {
  const candles = breakoutCandles(
    { open: 100, high: 100.5, low: 89, close: 90 },
    { open: 88, high: 89, low: 83, close: 85 },
  );

  const result = await runPerpetualBacktestOnCandles(shortBreakoutDsl(), candles, [], costless);

  assert.equal(result.trades[0].side, "short");
  assert.equal(result.trades[0].entryPrice, 88);
  assert.equal(result.trades[0].openedAt, candles[201].openTime);
  assert.ok(Math.abs(result.trades[0].exitPrice - 84.48) < 1e-9);
  assert.equal(result.trades[0].reason, "take_profit");
  assert.ok(result.trades[0].netPnl > 0);
});

test("uses stop-loss first when the same candle touches both stop and take-profit", async () => {
  const candles = breakoutCandles(
    { open: 100, high: 100.5, low: 89, close: 90 },
    { open: 90, high: 93, low: 85, close: 89 },
  );

  const result = await runPerpetualBacktestOnCandles(shortBreakoutDsl(), candles, [], costless);

  assert.equal(result.trades[0].reason, "stop_loss");
  assert.equal(result.trades[0].exitPrice, 91.8);
  assert.ok(result.trades[0].netPnl < 0);
});

test("applies positive funding as a short credit and a long debit", async () => {
  const candles = breakoutCandles(
    { open: 100, high: 100.5, low: 89, close: 90 },
    { open: 90, high: 90.5, low: 89.5, close: 90 },
  );
  const funding = [{ time: candles[202].openTime, rate: 0.001 }];
  const shortDsl = shortBreakoutDsl({ stopLossPct: 19, takeProfitPct: 20 });
  const longDsl = {
    ...shortDsl,
    name: "BTC 多头突破",
    direction: "long_only",
    legs: {
      long: {
        entry: { all: [{ type: "channel_breakout", period: 20, direction: "below" }] },
        exit: { any: [] },
        stopLossPct: 19,
        takeProfitPct: 20,
      },
    },
  };

  const shortResult = await runPerpetualBacktestOnCandles(shortDsl, candles, funding, costless);
  const longResult = await runPerpetualBacktestOnCandles(longDsl, candles, funding, costless);

  assert.ok(shortResult.fundingUsdt > 0);
  assert.ok(longResult.fundingUsdt < 0);
});

test("marks a position liquidated when a gap crosses isolated 1x maintenance margin before its stop", async () => {
  const candles = breakoutCandles(
    { open: 100, high: 100.5, low: 89, close: 90 },
    { open: 100, high: 101, low: 99, close: 100 },
  );
  candles[202] = candle(202, { open: 210, high: 211, low: 205, close: 208 });

  const result = await runPerpetualBacktestOnCandles(
    shortBreakoutDsl({ stopLossPct: 19, takeProfitPct: 20 }),
    candles,
    [],
    { ...costless, maintenanceMarginRate: 0.005 },
  );

  assert.equal(result.liquidated, true);
  assert.equal(result.trades[0].reason, "liquidation");
  assert.ok(result.trades[0].netPnl < 0);
});
