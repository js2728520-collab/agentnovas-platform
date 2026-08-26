import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_ADMISSION_RECORD_REASON,
  shouldPersistAdmission,
} from "../packages/domain/src/runtime/admission.ts";

// 组合级准入的留痕判定。
//
// 决策轮共享，准入逐组合。多数 K 线是 hold——若每个组合都写一行，5,000 会员 ×
// 3 张卡在 15m 周期下每天约 144 万行。已定决策是纯 hold 不留痕。

test("纯 hold 不留痕", () => {
  assert.equal(shouldPersistAdmission({ action: "hold", riskApproved: true, hasOrderIntent: false }), false);
});

test("产生订单意图必须留痕", () => {
  assert.equal(shouldPersistAdmission({ action: "enter_long", riskApproved: true, hasOrderIntent: true }), true);
});

test("风控拒绝必须留痕——这是「为什么我没成交」的唯一答案", () => {
  assert.equal(shouldPersistAdmission({ action: "enter_long", riskApproved: false, hasOrderIntent: false }), true);
});

test("组合级拒绝理由必须留痕，即使动作是 hold", () => {
  // 熔断、访问状态降级、风控读数不可用——这些是「同一轮里这个客户与别人不同」
  // 的地方，不留痕就没法回答「为什么我没成交而他成交了」。
  assert.equal(shouldPersistAdmission({
    action: "hold", riskApproved: true, hasOrderIntent: false,
    rejectionReasons: ["运行部署已触发熔断"],
  }), true);
});

test("非 hold 的动作即使没有意图也留痕", () => {
  // exit 被吞掉是最危险的静默，必须可查。
  assert.equal(shouldPersistAdmission({ action: "exit", riskApproved: true, hasOrderIntent: false }), true);
});

test("空的拒绝理由数组不触发留痕", () => {
  assert.equal(shouldPersistAdmission({
    action: "hold", riskApproved: true, hasOrderIntent: false, rejectionReasons: [],
  }), false);
});

test("查不到记录时的说明不能让人以为系统漏了一轮", () => {
  assert.match(NO_ADMISSION_RECORD_REASON, /不动作/);
  assert.match(NO_ADMISSION_RECORD_REASON, /公共决策轮/);
});
