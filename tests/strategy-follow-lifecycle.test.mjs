import assert from "node:assert/strict";
import test from "node:test";

import {
  activateFollow,
  confirmFollow,
  FOLLOW_LIFECYCLE_STATES,
  followAllowsNewEntry,
  pauseFollow,
  resumeFollow,
  STOP_AUTHORITIES,
  stopFollow,
} from "../packages/domain/src/strategy-follow-lifecycle.ts";

test("生命周期覆盖 PRD 6.6 的六个状态", () => {
  assert.deepEqual([...FOLLOW_LIFECYCLE_STATES],
    ["configuring", "user_confirmed", "active", "paused", "risk_blocked", "stopped"]);
  assert.deepEqual([...STOP_AUTHORITIES],
    ["customer", "operations_risk", "automated_risk", "global_circuit_breaker"]);
});

test("客户暂停落到 paused，风控暂停落到 risk_blocked", () => {
  // 两者的差别不是措辞而是谁能恢复。把风控阻断记成普通暂停，客户下一秒就能自己点恢复。
  assert.deepEqual(pauseFollow("active", "customer"),
    { allowed: true, nextState: "paused", pausedBy: "customer" });
  for (const authority of ["operations_risk", "automated_risk", "global_circuit_breaker"]) {
    assert.deepEqual(pauseFollow("active", authority),
      { allowed: true, nextState: "risk_blocked", pausedBy: authority });
  }
});

test("客户不能自行解除风控阻断", () => {
  // 这是整个模块存在的理由：没有它，风控判定形同虚设而界面上完全看不出异常。
  const blocked = resumeFollow("risk_blocked", { pausedBy: "automated_risk", authority: "customer" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "insufficient_authority");

  // 运营风控也解除不了自动风控之上的熔断。
  assert.equal(
    resumeFollow("risk_blocked", { pausedBy: "global_circuit_breaker", authority: "operations_risk" }).reason,
    "insufficient_authority",
  );
  // 同级或更强的权威可以。
  assert.deepEqual(resumeFollow("risk_blocked", { pausedBy: "automated_risk", authority: "automated_risk" }),
    { allowed: true, nextState: "active", pausedBy: null });
  assert.deepEqual(resumeFollow("risk_blocked", { pausedBy: "operations_risk", authority: "global_circuit_breaker" }),
    { allowed: true, nextState: "active", pausedBy: null });
});

test("客户可以恢复自己暂停的跟随", () => {
  assert.deepEqual(resumeFollow("paused", { pausedBy: "customer", authority: "customer" }),
    { allowed: true, nextState: "active", pausedBy: null });
});

test("来历不明的停止按最强权威处理", () => {
  // 缺 pausedBy 的记录不该被最弱的一方解除——数据缺失的方向应该指向更严格。
  for (const missing of [null, undefined, "", "不存在的权威"]) {
    const result = resumeFollow("risk_blocked", { pausedBy: missing, authority: "operations_risk" });
    assert.equal(result.allowed, false, `pausedBy=${String(missing)} 时不应被运营解除`);
    assert.equal(result.reason, "insufficient_authority");
  }
  assert.equal(resumeFollow("risk_blocked", { pausedBy: null, authority: "global_circuit_breaker" }).allowed, true);
});

test("终止不设权威门槛——不把人困在想退出的仓位里", () => {
  // 让客户在风控阻断期间也能彻底停掉跟随，比「保持阻断」更安全。
  for (const state of ["user_confirmed", "active", "paused", "risk_blocked"]) {
    for (const authority of STOP_AUTHORITIES) {
      assert.deepEqual(stopFollow(state, authority),
        { allowed: true, nextState: "stopped", pausedBy: null }, `${state} × ${authority}`);
    }
  }
  // 终态不可再终止。
  assert.equal(stopFollow("stopped", "customer").allowed, false);
});

test("终止是终态，不能恢复", () => {
  assert.equal(resumeFollow("stopped", { pausedBy: "customer", authority: "customer" }).allowed, false);
  assert.equal(pauseFollow("stopped", "customer").allowed, false);
});

test("确认与激活各自一步，参数未确认时不能暂停", () => {
  assert.deepEqual(confirmFollow("configuring"), { allowed: true, nextState: "user_confirmed", pausedBy: null });
  assert.equal(confirmFollow("active").allowed, false);
  assert.deepEqual(activateFollow("user_confirmed"), { allowed: true, nextState: "active", pausedBy: null });
  // 跳过确认直接激活会绕过风险披露确认。
  assert.equal(activateFollow("configuring").allowed, false);
  // 还在填参数的跟随没有东西可暂停。
  assert.equal(pauseFollow("configuring", "customer").allowed, false);
});

test("只有 active 产生新开仓", () => {
  for (const state of FOLLOW_LIFECYCLE_STATES) {
    assert.equal(followAllowsNewEntry(state), state === "active", `${state} 的开仓判定`);
  }
});

test("未知状态与未知权威不猜", () => {
  assert.equal(pauseFollow("running", "customer").reason, "unknown_state");
  assert.equal(pauseFollow("active", "admin").reason, "unknown_authority");
  assert.equal(stopFollow(null, "customer").reason, "unknown_state");
});
