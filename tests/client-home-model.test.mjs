import assert from "node:assert/strict";
import test from "node:test";

const { derivePaperPortfolioSummary } = await import("../apps/client/ui/client-home-model.ts");

test("home portfolio summary uses only server-returned paper balances", () => {
  assert.deepEqual(derivePaperPortfolioSummary([
    { equityUsdt: "10025.50", realizedNetPnlUsdt: "12.25", unrealizedPnlUsdt: "13.25", openPositionCount: 2, status: "ACTIVE", runtime: { state: "ACTIVE" }, updatedAt: "2026-08-29T08:00:00.000Z" },
    { equityUsdt: "9980.00", realizedNetPnlUsdt: "-15.00", unrealizedPnlUsdt: "-5.00", openPositionCount: 1, status: "CLOSE_ONLY", runtime: { state: "PAUSED" }, updatedAt: "2026-08-29T08:02:00.000Z" },
    { equityUsdt: "10010.25", realizedNetPnlUsdt: "0.25", unrealizedPnlUsdt: "10.00", openPositionCount: 0, status: "ACTIVE", runtime: { state: "NOT_STARTED" }, updatedAt: "2026-08-29T08:01:00.000Z" },
  ]), {
    totalEquityUsdt: 30015.75,
    realizedNetPnlUsdt: -2.5,
    unrealizedPnlUsdt: 18.25,
    totalOpenPositionCount: 3,
    activePortfolioCount: 2,
    runningStrategyCount: 1,
    attentionPortfolioCount: 1,
    latestUpdatedAt: "2026-08-29T08:02:00.000Z",
  });
});

test("home portfolio summary keeps empty and malformed observations explicit", () => {
  assert.deepEqual(derivePaperPortfolioSummary([]), {
    totalEquityUsdt: 0,
    realizedNetPnlUsdt: 0,
    unrealizedPnlUsdt: 0,
    totalOpenPositionCount: 0,
    activePortfolioCount: 0,
    runningStrategyCount: 0,
    attentionPortfolioCount: 0,
    latestUpdatedAt: null,
  });
  const summary = derivePaperPortfolioSummary([{
    equityUsdt: "not-a-number",
    realizedNetPnlUsdt: "NaN",
    unrealizedPnlUsdt: "Infinity",
    openPositionCount: 0,
    status: "READ_ONLY",
    runtime: { state: "FAILED" },
    updatedAt: "invalid",
  }]);
  assert.equal(summary.totalEquityUsdt, 0);
  assert.equal(summary.attentionPortfolioCount, 1);
  assert.equal(summary.latestUpdatedAt, null);
});
