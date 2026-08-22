import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidOrderIntent,
  isOrderIntentExpired,
  OrderIntentError,
} from "../packages/domain/src/execution/order-intent.ts";
import { resolveOrderQuantity } from "../packages/domain/src/execution/execution-port.ts";

// 订单意图与执行端口。
//
// 域层只产出意图，不产出订单：意图不知道交易所、不知道凭证、不知道签名。
// 平台的目标形态是真实交易 + 策略跟单，这条缝现在就要维持住，否则 GA 接入
// 真实执行时域层要重做。

function draft(overrides = {}) {
  return {
    provenance: {
      decisionRoundId: "dr_20260822_0915_bal",
      traceId: "tr_9f31c2a7e40b",
      contractHash: "sha256:abc",
      candleId: "BTCUSDT:1h:1755840000000",
    },
    symbol: "BTC/USDT",
    side: "buy",
    targetPositionRatio: 0.12,
    entryPriceRange: { min: 98000, max: 98500 },
    stopLossPrice: 96000,
    takeProfitPrice: 102000,
    validUntil: "2026-08-22T13:15:00.000Z",
    ...overrides,
  };
}

test("合法的买入意图通过校验", () => {
  assert.doesNotThrow(() => assertValidOrderIntent(draft()));
});

test("目标仓位比例必须落在 (0, 1]", () => {
  for (const ratio of [0, -0.1, 1.5, Number.NaN]) {
    assert.throws(() => assertValidOrderIntent(draft({ targetPositionRatio: ratio })),
      (error) => error instanceof OrderIntentError && error.code === "INTENT_RATIO_INVALID",
      `比例 ${ratio} 应被拒绝`);
  }
});

test("买入意图的止损价高于入场下限会被拒绝", () => {
  // 方向写反的意图流到执行端，会变成「一进场就触发止损」。
  assert.throws(() => assertValidOrderIntent(draft({ stopLossPrice: 99000 })),
    (error) => error.code === "INTENT_STOP_LOSS_ABOVE_ENTRY");
});

test("买入意图的止盈价低于入场上限会被拒绝", () => {
  assert.throws(() => assertValidOrderIntent(draft({ takeProfitPrice: 98200 })),
    (error) => error.code === "INTENT_TAKE_PROFIT_BELOW_ENTRY");
});

test("卖出意图的止损止盈方向相反", () => {
  const sell = draft({ side: "sell", stopLossPrice: 99000, takeProfitPrice: 95000 });
  assert.doesNotThrow(() => assertValidOrderIntent(sell));
  assert.throws(() => assertValidOrderIntent({ ...sell, stopLossPrice: 97000 }),
    (error) => error.code === "INTENT_STOP_LOSS_BELOW_EXIT");
});

test("入场价格区间必须有序且为正", () => {
  assert.throws(() => assertValidOrderIntent(draft({ entryPriceRange: { min: 98500, max: 98000 } })),
    (error) => error.code === "INTENT_PRICE_RANGE_INVALID");
  assert.throws(() => assertValidOrderIntent(draft({ entryPriceRange: { min: 0, max: 100 } })),
    (error) => error.code === "INTENT_PRICE_RANGE_INVALID");
});

test("有效期判定由调用方传入时间，域层不读时钟", () => {
  const intent = { validUntil: "2026-08-22T13:15:00.000Z" };
  assert.equal(isOrderIntentExpired(intent, new Date("2026-08-22T13:14:59.000Z")), false);
  assert.equal(isOrderIntentExpired(intent, new Date("2026-08-22T13:15:01.000Z")), true);
});

test("下单量取「意图目标比例」与「组合上限比例」中更严格者", () => {
  const base = {
    intent: { targetPositionRatio: 0.2 },
    portfolioId: "p1",
    availableCapital: 10_000,
    capitalCapRatio: 0.03,
  };
  // 客户设定的 3% 上限不能被策略的 20% 意图突破。
  assert.equal(resolveOrderQuantity(base, 100), 3);
  // 反过来，意图更保守时以意图为准。
  assert.equal(resolveOrderQuantity({ ...base, intent: { targetPositionRatio: 0.01 } }, 100), 1);
});

test("参考价非法时拒绝换算，不返回近似值", () => {
  const request = { intent: { targetPositionRatio: 0.1 }, portfolioId: "p1", availableCapital: 1000, capitalCapRatio: 0.1 };
  for (const price of [0, -1, Number.NaN]) {
    assert.throws(() => resolveOrderQuantity(request, price), /EXECUTION_REFERENCE_PRICE_INVALID/);
  }
});

test("可用资金为零时下单量为零而不是抛错", () => {
  // 空仓组合是正常状态，不该当成错误；真正的错误是价格非法。
  const request = { intent: { targetPositionRatio: 0.1 }, portfolioId: "p1", availableCapital: 0, capitalCapRatio: 0.1 };
  assert.equal(resolveOrderQuantity(request, 100), 0);
});
