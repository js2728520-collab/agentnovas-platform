import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCreditDelta,
  isValidCreditMutation,
  planReservationRelease,
  planReservationSettlement,
  resolveReservationTransition,
} from "../packages/domain/src/credits/credit-ledger.ts";

// AI Credits 账本规则。
//
// Credits 是客户预付的钱，扣错就是收错钱。这套算术此前只能通过 *-postgres 测试
// 间接验证：每验一条规则要建 schema、开事务，于是实际只覆盖了主干路径。
// 下面是那些从没被直接测过的边界——它们正是扣错钱的方式。

const n = (value) => BigInt(value);
const delta = (available, reserved) => ({ availableDelta: n(available), reservedDelta: n(reserved) });

test("grant 只增可用余额，不动预留", () => {
  assert.equal(isValidCreditMutation("grant", delta(100, 0)), true);
  assert.equal(isValidCreditMutation("grant", delta(100, 5)), false, "grant 不该动预留");
  assert.equal(isValidCreditMutation("grant", delta(-100, 0)), false, "grant 不能是扣减");
  assert.equal(isValidCreditMutation("grant", delta(0, 0)), false, "空操作不该入账");
});

test("reserve 是可用到预留的等额搬运，总量不变", () => {
  assert.equal(isValidCreditMutation("reserve", delta(-100, 100)), true);
  assert.equal(isValidCreditMutation("reserve", delta(-100, 90)), false, "不等额会凭空销毁 credits");
  assert.equal(isValidCreditMutation("reserve", delta(-100, 110)), false, "不等额会凭空造出 credits");
  assert.equal(isValidCreditMutation("reserve", delta(100, -100)), false, "方向反了就是 release");
});

test("release 是预留到可用的等额退回", () => {
  assert.equal(isValidCreditMutation("release", delta(100, -100)), true);
  assert.equal(isValidCreditMutation("release", delta(100, -90)), false);
});

test("settle 释放整笔预留，且总量只减不增", () => {
  // 预留 100，实耗 30：退回 70，清掉 100，净减 30。
  assert.equal(isValidCreditMutation("settle", delta(70, -100)), true);
  // 全部用掉：退回 0。
  assert.equal(isValidCreditMutation("settle", delta(0, -100)), true);
  // 退回超过预留 —— 结算不能凭空造出 credits。
  assert.equal(isValidCreditMutation("settle", delta(120, -100)), false);
  assert.equal(isValidCreditMutation("settle", delta(-10, -100)), false, "退回额不能为负");
  assert.equal(isValidCreditMutation("settle", delta(0, 100)), false, "预留必须被扣减");
});

test("adjust 只动可用余额，正负皆可，但不能是空操作", () => {
  assert.equal(isValidCreditMutation("adjust", delta(50, 0)), true);
  assert.equal(isValidCreditMutation("adjust", delta(-50, 0)), true);
  assert.equal(isValidCreditMutation("adjust", delta(0, 0)), false);
  assert.equal(isValidCreditMutation("adjust", delta(50, 1)), false, "调整不该动预留");
});

test("余额不足返回 null 而不是夹到 0", () => {
  const balance = { available: n(50), reserved: n(0) };
  assert.equal(applyCreditDelta(balance, delta(-80, 80)), null);
  // 静默夹到 0 会让客户在没钱时也调用到模型（INV-7 失败安全）。
  assert.deepEqual(applyCreditDelta(balance, delta(-50, 50)), { available: n(0), reserved: n(50) });
});

test("预留余额也不能被扣成负数", () => {
  const balance = { available: n(0), reserved: n(10) };
  assert.equal(applyCreditDelta(balance, delta(20, -20)), null);
});

test("结算按实耗退回未用部分", () => {
  const plan = planReservationSettlement(n(100), n(30));
  assert.deepEqual(plan, { ok: true, delta: delta(70, -100), settledCredits: n(30) });
  // 结算产出的 delta 必须自洽地通过形状规则。
  assert.equal(isValidCreditMutation("settle", plan.delta), true);
});

test("实耗超过预留时拒绝，不自动补扣", () => {
  // 预留额是事前对客户承诺的花费上限，超出应当由人来查，不能让系统多划一笔。
  assert.deepEqual(planReservationSettlement(n(100), n(101)), { ok: false, reason: "EXCEEDS_RESERVATION" });
  assert.equal(planReservationSettlement(n(100), n(100)).ok, true, "刚好用满应当放行");
});

test("释放把整笔预留原路退回", () => {
  const released = planReservationRelease(n(100));
  assert.deepEqual(released, delta(100, -100));
  assert.equal(isValidCreditMutation("release", released), true);
});

test("重复结算/释放是幂等重放，不是新的一笔", () => {
  assert.equal(resolveReservationTransition("settled", "settled"), "replay");
  assert.equal(resolveReservationTransition("released", "released"), "replay");
  assert.equal(resolveReservationTransition("reserved", "settled"), "proceed");
  assert.equal(resolveReservationTransition("reserved", "released"), "proceed");
});

test("跨终态的转移是冲突，不能补一笔", () => {
  // 结算一笔已释放的预留会重复扣费。
  assert.equal(resolveReservationTransition("released", "settled"), "conflict");
  assert.equal(resolveReservationTransition("settled", "released"), "conflict");
});
