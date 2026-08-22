import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveExecutionSide,
  toExecutionOrderIntent,
} from "../packages/domain/src/execution/intent-translation.ts";

/** 错误身份在 code 上，消息是给人看的中文。断言 code，与域层其它测试一致。 */
function throwsWithCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 code=${code}，实际 ${error.code}（${error.message}）`);
    return;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

const NOW = new Date("2026-08-23T00:00:00.000Z");

const CONTEXT = {
  symbol: "BTC/USDT",
  strategyCode: "trend-v1",
  decisionRoundId: "round-1",
  traceId: "trace-1",
  contractHash: "hash-1",
  targetPositionRatio: 0.2,
  stopLossPct: 5,
  takeProfitPct: 10,
  slippageTolerancePct: 0.5,
  validForMs: 60_000,
};

function runtimeIntent(overrides = {}) {
  return {
    idempotencyKey: "deploy-1:1756000000000:enter_long",
    action: "enter_long",
    side: "long",
    requestedPrice: 100,
    confirmedAtCandleCloseTime: 1756000000000,
    ...overrides,
  };
}

test("开多翻译成买入，止损在下止盈在上", () => {
  const intent = toExecutionOrderIntent(runtimeIntent(), CONTEXT, NOW);
  assert.equal(intent.side, "buy");
  assert.equal(intent.symbol, "BTC/USDT");
  assert.deepEqual(intent.entryPriceRange, { min: 99.5, max: 100.5 });
  assert.ok(intent.stopLossPrice < intent.entryPriceRange.min);
  assert.ok(intent.takeProfitPrice > intent.entryPriceRange.max);
});

test("平仓翻译成卖出，止损止盈方向相反", () => {
  const intent = toExecutionOrderIntent(runtimeIntent({ action: "exit", side: null }), CONTEXT, NOW);
  assert.equal(intent.side, "sell");
  assert.ok(intent.stopLossPrice > intent.entryPriceRange.max);
  assert.ok(intent.takeProfitPrice < intent.entryPriceRange.min);
});

test("做空必须抛错，不得被静默忽略", () => {
  // 现货做不了空。悄悄丢掉会让上层以为「这一轮没有动作」，而实际是策略要求了一个
  // 我们做不到的动作——那必须显式暴露（INV-6）。
  throwsWithCode(() => resolveExecutionSide("enter_short"), "SHORT_NOT_EXECUTABLE_ON_SPOT");
  throwsWithCode(
    () => toExecutionOrderIntent(runtimeIntent({ action: "enter_short", side: "short" }), CONTEXT, NOW),
    "SHORT_NOT_EXECUTABLE_ON_SPOT",
  );
});

test("无法识别的动作抛错，不猜", () => {
  throwsWithCode(() => resolveExecutionSide("something_new"), "UNKNOWN_RUNTIME_ACTION");
});

test("意图 id 沿用引擎的幂等键，重放得到同一条", () => {
  // 换成随机 id 会让重放产出两条不同的意图，幂等下单也就无从谈起（INV-8）。
  const first = toExecutionOrderIntent(runtimeIntent(), CONTEXT, NOW);
  const second = toExecutionOrderIntent(runtimeIntent(), CONTEXT, NOW);
  assert.equal(first.id, "deploy-1:1756000000000:enter_long");
  assert.deepEqual(first, second);
});

test("溯源带上策略卡与 K 线标识", () => {
  const intent = toExecutionOrderIntent(runtimeIntent(), CONTEXT, NOW);
  assert.equal(intent.provenance.strategyCode, "trend-v1");
  assert.equal(intent.provenance.decisionRoundId, "round-1");
  assert.equal(intent.provenance.candleId, "1756000000000");
});

test("有效期从传入的时刻算起，不读时钟", () => {
  const intent = toExecutionOrderIntent(runtimeIntent(), CONTEXT, NOW);
  assert.equal(intent.validUntil, "2026-08-23T00:01:00.000Z");
});

test("没有止盈时保持 null，不编一个", () => {
  const intent = toExecutionOrderIntent(runtimeIntent(), { ...CONTEXT, takeProfitPct: null }, NOW);
  assert.equal(intent.takeProfitPrice, null);
});

test("决策价非法直接抛", () => {
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    throwsWithCode(
      () => toExecutionOrderIntent(runtimeIntent({ requestedPrice: price }), CONTEXT, NOW),
      "REQUESTED_PRICE_INVALID",
    );
  }
});

test("滑点带宽非法直接抛，不套一个默认值", () => {
  for (const tolerance of [0, -1, 100, Number.NaN]) {
    throwsWithCode(
      () => toExecutionOrderIntent(runtimeIntent(), { ...CONTEXT, slippageTolerancePct: tolerance }, NOW),
      "SLIPPAGE_TOLERANCE_INVALID",
    );
  }
});

test("翻译结果必须通过域层既有的意图自洽性校验", () => {
  // 止损百分比大到把止损价压到零以下时，assertValidOrderIntent 应该拦住。
  try {
    toExecutionOrderIntent(runtimeIntent(), { ...CONTEXT, stopLossPct: 200 }, NOW);
    assert.fail("止损价被压到零以下时必须抛错");
  } catch (error) {
    assert.match(error.code, /^INTENT_STOP_LOSS/);
  }
});

test("仓位比例超出 (0,1] 被域层校验拦住", () => {
  throwsWithCode(
    () => toExecutionOrderIntent(runtimeIntent(), { ...CONTEXT, targetPositionRatio: 1.5 }, NOW),
    "INTENT_RATIO_INVALID",
  );
});
