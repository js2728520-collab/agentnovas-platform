import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_CANDLE_CLOSE_GRACE_MS,
  completedRuntimeCandlesAt,
  evaluateRuntimeCandleAdmission,
} from "../packages/domain/src/runtime/market-admission.ts";
import { evaluateStrategyRuntimeCycle } from "../packages/domain/src/strategy-runtime-engine.ts";

const HOUR_MS = 3_600_000;

function entryCandles() {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * HOUR_MS,
    closeTime: (index + 1) * HOUR_MS - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  rows[29] = { ...rows[29], high: 112, close: 111 };
  return rows;
}

const dsl = {
  schemaVersion: 3,
  name: "行情准入测试",
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

function evaluate({ rows = entryCandles(), evaluatedAt, position = null }) {
  return evaluateStrategyRuntimeCycle({
    deploymentId: "runtime-market-admission",
    strategyVersionId: "version-a",
    dsl,
    candles: rows,
    mode: "paper",
    position,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
    marketData: {
      evaluatedAt,
      latestClosedAt: rows.at(-1).closeTime,
      timeframe: "1h",
    },
  });
}

test("filters a valid current incomplete tail before cycle selection", () => {
  const rows = entryCandles();
  const currentIncomplete = {
    ...rows.at(-1),
    openTime: rows.at(-1).closeTime + 1,
    closeTime: rows.at(-1).closeTime + HOUR_MS,
  };
  const evaluatedAt = rows.at(-1).closeTime + 10_000;
  assert.deepEqual(completedRuntimeCandlesAt([...rows, currentIncomplete], evaluatedAt), rows);
});

test("marks the exact timeframe plus close grace boundary stale", () => {
  const latestClosedAt = 10 * HOUR_MS;
  const staleAfterMs = HOUR_MS + RUNTIME_CANDLE_CLOSE_GRACE_MS;
  assert.deepEqual(evaluateRuntimeCandleAdmission({
    latestClosedAt,
    evaluatedAt: latestClosedAt + staleAfterMs - 1,
    timeframe: "1h",
  }), {
    quality: "fresh",
    ageMs: staleAfterMs - 1,
    staleAfterMs,
    latestClosedAt: new Date(latestClosedAt).toISOString(),
    entryAllowed: true,
    reason: null,
  });
  assert.deepEqual(evaluateRuntimeCandleAdmission({
    latestClosedAt,
    evaluatedAt: latestClosedAt + staleAfterMs,
    timeframe: "1h",
  }), {
    quality: "stale",
    ageMs: staleAfterMs,
    staleAfterMs,
    latestClosedAt: new Date(latestClosedAt).toISOString(),
    entryAllowed: false,
    reason: "latest_closed_candle_stale",
  });
});

test("unknown timeframes and future latest-closed timestamps fail closed", () => {
  assert.equal(evaluateRuntimeCandleAdmission({ latestClosedAt: 1, evaluatedAt: 2, timeframe: "2h" }).quality, "invalid");
  assert.equal(evaluateRuntimeCandleAdmission({ latestClosedAt: 3, evaluatedAt: 2, timeframe: "1h" }).quality, "invalid");
  assert.equal(evaluateRuntimeCandleAdmission({ latestClosedAt: Number.NaN, evaluatedAt: 2, timeframe: "1h" }).quality, "invalid");
  assert.equal(evaluateRuntimeCandleAdmission({ latestClosedAt: Number.MAX_SAFE_INTEGER, evaluatedAt: Number.MAX_SAFE_INTEGER, timeframe: "1h" }).quality, "invalid");
});

test("the engine rejects mismatched candle identity or timeframe instead of trusting caller labels", () => {
  const rows = entryCandles();
  const evaluatedAt = rows.at(-1).closeTime + 1;
  const base = evaluate({ rows, evaluatedAt });
  assert.equal(base.marketAdmission.quality, "fresh");

  const mismatchedClose = evaluateStrategyRuntimeCycle({
    deploymentId: "runtime-market-mismatch",
    strategyVersionId: "version-a",
    dsl,
    candles: rows,
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
    marketData: { evaluatedAt, latestClosedAt: rows.at(-2).closeTime, timeframe: "1h" },
  });
  assert.equal(mismatchedClose.marketAdmission.quality, "invalid");
  assert.equal(mismatchedClose.decision.riskApproved, false);

  const mismatchedTimeframe = evaluateStrategyRuntimeCycle({
    deploymentId: "runtime-market-mismatch",
    strategyVersionId: "version-a",
    dsl,
    candles: rows,
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
    marketData: { evaluatedAt, latestClosedAt: rows.at(-1).closeTime, timeframe: "5m" },
  });
  assert.equal(mismatchedTimeframe.marketAdmission.quality, "invalid");
  assert.equal(mismatchedTimeframe.decision.riskApproved, false);
});

test("missing server-derived market admission fails explicitly", () => {
  const rows = entryCandles();
  assert.throws(() => evaluateStrategyRuntimeCycle({
    deploymentId: "runtime-market-missing",
    strategyVersionId: "version-a",
    dsl,
    candles: rows,
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
  }), /缺少服务端行情时间准入/);
});

test("stale market data rejects a new entry and records truthful market evidence", () => {
  const rows = entryCandles();
  const result = evaluate({ rows, evaluatedAt: rows.at(-1).closeTime + HOUR_MS + RUNTIME_CANDLE_CLOSE_GRACE_MS });
  assert.equal(result.decision.action, "enter_long");
  assert.equal(result.decision.riskApproved, false);
  assert.equal(result.orderIntent, null);
  assert.ok(result.decision.rejectionReasons.some((reason) => reason.includes("陈旧")));
  assert.equal(result.marketAdmission.quality, "stale");
  assert.equal(result.events[0].evidence.quality, "stale");
  assert.match(result.events[0].conclusion, /陈旧/);
});

test("stale market data never traps an existing position", () => {
  const rows = entryCandles();
  rows[29] = { ...rows[29], open: 100, high: 101, low: 95, close: 96 };
  const result = evaluate({
    rows,
    evaluatedAt: rows.at(-1).closeTime + HOUR_MS + RUNTIME_CANDLE_CLOSE_GRACE_MS,
    position: { side: "long", entryPrice: 100, quantity: 1 },
  });
  assert.equal(result.decision.action, "exit");
  assert.equal(result.decision.riskApproved, true);
  assert.ok(result.orderIntent);
  assert.equal(result.marketAdmission.entryAllowed, false);
});
