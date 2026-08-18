import assert from "node:assert/strict";
import test from "node:test";

import { evaluateStrategyRuntimeCycle } from "../lib/strategy-runtime-engine.ts";

const dsl = {
  schemaVersion: 3,
  name: "运行时突破",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: { long: {
    entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
    exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
    stopLossPct: 2,
    takeProfitPct: 4,
  } },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

function candles() {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  rows[29] = { ...rows[29], open: 100, high: 112, low: 99, close: 111 };
  return rows;
}

test("emits seven independent deterministic runtime agent events and a next-open intent", () => {
  const result = evaluateStrategyRuntimeCycle({
    deploymentId: "deployment-a",
    strategyVersionId: "version-a",
    dsl,
    candles: candles(),
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
  });

  assert.deepEqual(result.events.map(event => event.role), [
    "market_data", "technical_analysis", "strategy_decision", "adversarial_review",
    "risk", "execution", "audit",
  ]);
  assert.equal(result.decision.action, "enter_long");
  assert.equal(result.decision.riskApproved, true);
  assert.equal(result.orderIntent.executionTiming, "next_candle_open");
  assert.equal(result.orderIntent.idempotencyKey, `deployment-a:${candles().at(-1).closeTime}:enter_long`);
  assert.equal(result.events[0].evidence.marketState, "trend_up");
  assert.equal(JSON.stringify(result).includes("providerName"), false);
});

test("deterministic risk rejection cannot be overridden by explanatory agents", () => {
  const result = evaluateStrategyRuntimeCycle({
    deploymentId: "deployment-a",
    strategyVersionId: "version-a",
    dsl,
    candles: candles(),
    mode: "shadow",
    position: null,
    riskState: { drawdownPct: 13, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
  });

  assert.equal(result.decision.action, "enter_long");
  assert.equal(result.decision.riskApproved, false);
  assert.equal(result.orderIntent, null);
  assert.ok(result.decision.rejectionReasons.some(reason => reason.includes("回撤")));
});

test("uses stop-loss before take-profit when both thresholds occur in one candle", () => {
  const rows = candles();
  rows[29] = { ...rows[29], open: 100, high: 106, low: 97, close: 101 };
  const result = evaluateStrategyRuntimeCycle({
    deploymentId: "deployment-a",
    strategyVersionId: "version-a",
    dsl,
    candles: rows,
    mode: "paper",
    position: { side: "long", entryPrice: 100, quantity: 1 },
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
  });

  assert.equal(result.decision.action, "exit");
  assert.equal(result.decision.reason, "stop_loss");
  assert.equal(result.orderIntent.executionTiming, "intrabar_threshold");
  assert.equal(result.orderIntent.requestedPrice, 98);
});
