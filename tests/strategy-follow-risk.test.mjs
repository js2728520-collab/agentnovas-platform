import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateFollowRisk,
  isPlatformRiskDelist,
  PLATFORM_RISK_DELIST_REASONS,
} from "../packages/domain/src/strategy-follow-risk.ts";

const facts = (overrides = {}) => ({
  drawdownPct: 3, stopLossPct: 10, listingStatus: "listed", delistReason: null, ...overrides,
});

test("用合同里客户自己设的止损线，不用 P-05 的准入阈值", () => {
  // P-05 那组按档位的回撤阈值是「能不能上架」的准入标准。混用会让一个保守档策略的客户
  // 在 10% 回撤时被停，即使他自己设的是 20%。
  assert.equal(evaluateFollowRisk(facts({ drawdownPct: 9.9 })).blocked, false);
  assert.equal(evaluateFollowRisk(facts({ drawdownPct: 10 })).blocked, true);
  assert.deepEqual(evaluateFollowRisk(facts({ drawdownPct: 10 })).triggeredRules, ["drawdown_stop_loss"]);

  // 同样 12% 的回撤，止损线 20% 的客户不被停。
  assert.equal(evaluateFollowRisk(facts({ drawdownPct: 12, stopLossPct: 20 })).blocked, false);
  assert.equal(evaluateFollowRisk(facts({ drawdownPct: 12, stopLossPct: 10 })).blocked, true);
});

test("止损线损坏时不触发——不擅自打断正在运行的仓位", () => {
  // 方向与准入判定相反是有意的：准入是「证据不足就拒绝」，这里是「证据不足就不行动」，
  // 因为这里的行动会打断一个正在运行的仓位。
  for (const broken of [Number.NaN, 0, -5, Infinity]) {
    const verdict = evaluateFollowRisk(facts({ drawdownPct: 99, stopLossPct: broken }));
    assert.equal(verdict.blocked, false, `stopLossPct=${broken} 不应触发阻断`);
    assert.ok(Number.isNaN(verdict.evidence.stopLossPct), "证据里要看得出阈值是坏的");
  }
  assert.equal(evaluateFollowRisk(facts({ drawdownPct: Number.NaN })).blocked, false);
});

test("下架按原因区分：作者主动不阻断，平台风险阻断", () => {
  // 两种下架的性质完全不同，合并处理会让其中一种错。
  for (const reason of ["author_request", "inactivity"]) {
    assert.equal(evaluateFollowRisk(facts({ listingStatus: "delisted", delistReason: reason })).blocked, false,
      `${reason} 不应阻断存量跟随`);
  }
  for (const reason of PLATFORM_RISK_DELIST_REASONS) {
    const verdict = evaluateFollowRisk(facts({ listingStatus: "delisted", delistReason: reason }));
    assert.equal(verdict.blocked, true, `${reason} 应阻断存量跟随`);
    assert.deepEqual(verdict.triggeredRules, ["platform_risk_delisting"]);
  }
  // 未下架时下架原因不起作用。
  assert.equal(evaluateFollowRisk(facts({ listingStatus: "listed", delistReason: "platform_risk" })).blocked, false);
  assert.equal(isPlatformRiskDelist(null), false);
  assert.equal(isPlatformRiskDelist("author_request"), false);
});

test("多条规则同时触发时都记下来", () => {
  // 只记第一条会让运维以为解决了那一条就能恢复。
  const verdict = evaluateFollowRisk(facts({
    drawdownPct: 15, stopLossPct: 10, listingStatus: "delisted", delistReason: "platform_risk",
  }));
  assert.deepEqual(verdict.triggeredRules.sort(), ["drawdown_stop_loss", "platform_risk_delisting"]);
  // 证据带实际值与阈值，客户能核对而不是只看到「被风控停了」。
  assert.deepEqual(verdict.evidence, { drawdownPct: 15, stopLossPct: 10, listingStatus: "delisted" });
});

test("运营端解除阻断不能由当初阻断的人自己做", async () => {
  const route = await readFile(
    new URL("../app/api/operations/follow-risk/[id]/decision/route.operations.ts", import.meta.url), "utf8");
  // 沿用熔断开关的不对称：挂上单人即时，摘除要第二个人。解除阻断是把风险重新打开。
  assert.match(route, /engager\.actor_user_id === actor\.id/);
  assert.match(route, /MAKER_CHECKER_REQUIRED/);
  assert.match(route, /不能由当初阻断的人自己解除/);
  // 阻断本身不需要第二个人——出事的时候没有时间等签字。
  const pauseBlock = route.slice(route.indexOf('if (action === "pause")'), route.indexOf('} else if (action === "stop")'));
  assert.doesNotMatch(pauseBlock, /MAKER_CHECKER|engager/);
});

test("平台风险下架会连带阻断存量跟随，作者主动下架不会", async () => {
  const route = await readFile(
    new URL("../app/api/operations/strategy-listing-reviews/[id]/decision/route.operations.ts", import.meta.url), "utf8");
  assert.match(route, /isPlatformRiskDelist\(delistReason\)/);
  assert.match(route, /status='risk_blocked', paused_by='operations_risk'/);
  // 下架必须说明原因，否则无从区分。
  assert.match(route, /STRATEGY_DELIST_REASON_INVALID/);
});
