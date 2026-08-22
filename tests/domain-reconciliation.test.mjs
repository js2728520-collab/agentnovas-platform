import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECONCILIATION_POLICY,
  admitNewEntry,
  decideReconciliation,
  reconciliationRetryDelayMs,
} from "../packages/domain/src/execution/reconciliation.ts";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function record(overrides = {}) {
  return {
    clientOrderId: "RV0001",
    accountId: "acct-1",
    symbol: "BTC/USDT",
    requestedQuantity: 1,
    attemptCount: 0,
    firstSeenAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

test("终态订单直接结案，并如实带出成交量", () => {
  const decision = decideReconciliation(record(),
    { kind: "order_found", state: "filled", filledQuantity: 1, averagePrice: 100 }, NOW);
  assert.equal(decision.action, "resolve");
  assert.equal(decision.outcome, "filled");
  assert.equal(decision.filledQuantity, 1);
});

test("终态但只成交一部分，结案为 partial", () => {
  const decision = decideReconciliation(record(),
    { kind: "order_found", state: "canceled", filledQuantity: 0.4, averagePrice: 100 }, NOW);
  assert.equal(decision.action, "resolve");
  assert.equal(decision.outcome, "partial");
  assert.equal(decision.filledQuantity, 0.4);
});

test("还在挂着就不结案——剩余量仍可能成交", () => {
  for (const state of ["live", "partially_filled"]) {
    const decision = decideReconciliation(record(),
      { kind: "order_found", state, filledQuantity: 0.3, averagePrice: 100 }, NOW);
    assert.equal(decision.action, "retry", `${state} 不应结案`);
  }
});

test("一直挂着不走的单最终升级人工，而不是无限等待", () => {
  const decision = decideReconciliation(
    record({ attemptCount: DEFAULT_RECONCILIATION_POLICY.maxAttempts - 1 }),
    { kind: "order_found", state: "live", filledQuantity: 0, averagePrice: 0 }, NOW);
  assert.equal(decision.action, "escalate");
  assert.match(decision.reason, /ORDER_STILL_OPEN/);
});

test("窗口内查不到订单，可以采信为从未下单", () => {
  const decision = decideReconciliation(record(), { kind: "order_absent" }, NOW);
  assert.equal(decision.action, "resolve");
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.rejectionReason, "ORDER_NEVER_PLACED");
});

test("窗口外查不到订单必须升级，不能当成未下单", () => {
  // 多数交易所只保留近期订单可查。把「过期不可查」判成「从未下单」会让一笔真实
  // 成交被当成未成交然后重试——重复下单。
  const stale = record({
    firstSeenAt: new Date(NOW - DEFAULT_RECONCILIATION_POLICY.absenceTrustWindowMs - 1).toISOString(),
  });
  const decision = decideReconciliation(stale, { kind: "order_absent" }, NOW);
  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "ABSENCE_NOT_TRUSTWORTHY");
});

test("时间戳损坏时升级，而不是默认为新鲜", () => {
  const decision = decideReconciliation(record({ firstSeenAt: "not-a-date" }), { kind: "order_absent" }, NOW);
  assert.equal(decision.action, "escalate");
  assert.equal(decision.reason, "FIRST_SEEN_AT_INVALID");
});

test("查询失败只重试，绝不推断订单状态", () => {
  const decision = decideReconciliation(record(), { kind: "query_failed", reason: "TIMEOUT" }, NOW);
  assert.equal(decision.action, "retry");
  assert.equal(decision.attemptCount, 1);
  assert.ok(decision.nextAttemptAtMs > NOW);
});

test("查询持续失败到次数耗尽后升级人工", () => {
  const decision = decideReconciliation(
    record({ attemptCount: DEFAULT_RECONCILIATION_POLICY.maxAttempts - 1 }),
    { kind: "query_failed", reason: "EXCHANGE_DOWN" }, NOW);
  assert.equal(decision.action, "escalate");
  assert.match(decision.reason, /QUERY_FAILED:EXCHANGE_DOWN/);
});

test("退避指数增长且有上限", () => {
  assert.equal(reconciliationRetryDelayMs(0), 30_000);
  assert.equal(reconciliationRetryDelayMs(1), 60_000);
  assert.equal(reconciliationRetryDelayMs(2), 120_000);
  assert.equal(reconciliationRetryDelayMs(99), DEFAULT_RECONCILIATION_POLICY.maxDelayMs);
});

// --- 开仓准入 -------------------------------------------------------------

test("升级人工后该账户全面停止开新仓", () => {
  const admission = admitNewEntry({ hasEscalated: true, pendingSymbols: [] }, "ETH/USDT");
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, "RECONCILIATION_ESCALATED");
});

test("仅待对账时只挡该品种，不连累其它品种", () => {
  const state = { hasEscalated: false, pendingSymbols: ["BTC/USDT"] };
  assert.equal(admitNewEntry(state, "BTC/USDT").allowed, false);
  assert.equal(admitNewEntry(state, "ETH/USDT").allowed, true);
});

test("无未决对账时正常放行", () => {
  const admission = admitNewEntry({ hasEscalated: false, pendingSymbols: [] }, "BTC/USDT");
  assert.equal(admission.allowed, true);
  assert.equal(admission.reason, null);
});
