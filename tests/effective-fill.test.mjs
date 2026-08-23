import assert from "node:assert/strict";
import test from "node:test";

import { isBookableFill, resolveEffectiveFill } from "../packages/domain/src/execution/effective-fill.ts";

const receipt = (over = {}) => ({
  outcome: "filled", filledQuantity: 0.5, averagePrice: 60_000, feeAmount: 30,
  rejectionReason: null, executedAt: "2026-08-23T10:00:00.000Z", ...over,
});
const recon = (over = {}) => ({
  status: "resolved", resolvedOutcome: "filled", filledQuantity: 0.5, averagePrice: 60_000,
  feeAmount: 30, rejectionReason: null, resolvedAt: "2026-08-23T10:05:00.000Z",
  acknowledgedAt: null, ...over,
});

test("没有对账记录时回执就是事实", () => {
  const fill = resolveEffectiveFill(receipt(), null);
  assert.equal(fill.state, "settled");
  assert.equal(fill.source, "receipt");
  assert.equal(fill.contradictsReceipt, false);
});

test("对账未决时事实未知——不能记账，也不能记成未成交", () => {
  // 把「不知道」记成「没成交」会让引擎认为没有仓位，继续开新仓；
  // 记成「成交了」则会凭空造出一个仓位。两个方向都会造成真实损失。
  const fill = resolveEffectiveFill(receipt(), recon({ status: "pending", resolvedOutcome: null }));
  assert.equal(fill.state, "unsettled");
  assert.equal(fill.reason, "RECONCILIATION_PENDING");
  assert.equal(isBookableFill(fill), false);
});

test("升级件即使运维已确认也仍然未决", () => {
  // 「已确认」的含义是人看过了，不是事实已知。事实要由人核对后显式结案。
  const fill = resolveEffectiveFill(receipt(), recon({
    status: "escalated", resolvedOutcome: null, acknowledgedAt: "2026-08-23T11:00:00.000Z",
  }));
  assert.equal(fill.state, "unsettled");
  assert.equal(fill.reason, "RECONCILIATION_ESCALATED");
});

test("结案后以对账为准，并标出它推翻了回执", () => {
  // 这是整条对账链存在的理由：回执停在 rejected，而这单其实成交了。
  // 不修正的话，客户手里有币而平台认为没有——引擎永远不会产出平仓意图。
  const fill = resolveEffectiveFill(
    receipt({ outcome: "rejected", filledQuantity: 0, averagePrice: 0, feeAmount: 0, rejectionReason: "TIMEOUT" }),
    recon(),
  );
  assert.equal(fill.state, "settled");
  assert.equal(fill.source, "reconciliation");
  assert.equal(fill.outcome, "filled");
  assert.equal(fill.filledQuantity, 0.5);
  assert.equal(fill.feeAmount, 30, "回执费用为 0，对账是费用的唯一来源");
  assert.equal(fill.contradictsReceipt, true);
  assert.equal(isBookableFill(fill), true);
});

test("反方向同样处理：回执说成交，对账查实从未下单", () => {
  const fill = resolveEffectiveFill(receipt(), recon({
    resolvedOutcome: "rejected", filledQuantity: 0, averagePrice: 0, feeAmount: 0,
    rejectionReason: "ORDER_NEVER_PLACED",
  }));
  assert.equal(fill.outcome, "rejected");
  assert.equal(fill.contradictsReceipt, true);
  assert.equal(isBookableFill(fill), false, "凭空记一个不存在的仓位，客户会被平掉一个没买过的币");
});

test("结论一致时不算推翻", () => {
  const fill = resolveEffectiveFill(receipt(), recon());
  assert.equal(fill.contradictsReceipt, false);
  assert.equal(fill.source, "reconciliation", "一致也以对账为准，来源要如实标注");
});

test("浮点末位差异不算推翻", () => {
  // 两条路径经过的浮点运算次数不同，要求完全相等会把每一单都标成矛盾，
  // 而一个永远报警的标记等于没有标记。
  const fill = resolveEffectiveFill(receipt(), recon({ filledQuantity: 0.5 + 1e-15 }));
  assert.equal(fill.contradictsReceipt, false);
});

test("真实的数量差异必须算推翻", () => {
  const fill = resolveEffectiveFill(receipt(), recon({ filledQuantity: 0.4 }));
  assert.equal(fill.contradictsReceipt, true, "部分成交被当成完全成交会去卖一个不存在的 0.1");
});

test("状态是 resolved 但字段缺失时判为未决，不退回回执", () => {
  // 「损坏时退回另一份记录」会让损坏永远不被发现。
  for (const missing of [
    { resolvedOutcome: null }, { filledQuantity: null }, { averagePrice: null },
    { feeAmount: null }, { resolvedAt: null },
  ]) {
    const fill = resolveEffectiveFill(receipt(), recon(missing));
    assert.equal(fill.state, "unsettled", `缺 ${Object.keys(missing)[0]} 时不该判为已结案`);
    assert.equal(fill.reason, "RECONCILIATION_RESOLVED_INCOMPLETE");
  }
});

test("零价或零量的成交不可记账", () => {
  // 一笔均价为 0 的成交进入分成计算，等于允许一笔无法结算的交易参与计费。
  for (const bad of [{ averagePrice: 0 }, { filledQuantity: 0 }]) {
    const fill = resolveEffectiveFill(receipt(), recon({ ...bad }));
    assert.equal(isBookableFill(fill), false);
  }
});

test("expired 与 rejected 一样不可记账", () => {
  const fill = resolveEffectiveFill(receipt(), recon({
    resolvedOutcome: "expired", filledQuantity: 0, averagePrice: 0, feeAmount: 0, rejectionReason: "EXPIRED",
  }));
  assert.equal(fill.state, "settled");
  assert.equal(isBookableFill(fill), false);
});
