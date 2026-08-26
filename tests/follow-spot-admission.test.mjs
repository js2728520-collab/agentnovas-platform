import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFollowSpotAdmission } from "../packages/domain/src/follow-spot-admission.ts";

/** 社区策略的 DSL 形状（V3）。官方卡是另一种形状，不能拿来当夹具。 */
const longOnlyV3 = {
  schemaVersion: 3,
  name: "跟单用 BTC 多头策略",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: {
    long: {
      entry: { all: [{ type: "price_ema", period: 10, operator: "above" }] },
      exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
      stopLossPct: 2,
      takeProfitPct: 4,
    },
  },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

const shortLeg = {
  entry: { all: [{ type: "price_ema", period: 10, operator: "below" }] },
  exit: { any: [{ type: "candle_direction", direction: "bullish" }] },
  stopLossPct: 2,
  takeProfitPct: 4,
};

function dsl(overrides = {}) {
  const next = { ...longOnlyV3, ...overrides };
  // 方向与腿必须一致，否则 DSL 本身就不合法，测到的会是解析失败而不是方向判定。
  if (next.direction === "short_only") next.legs = { short: shortLeg };
  if (next.direction === "both") next.legs = { long: longOnlyV3.legs.long, short: shortLeg };
  return next;
}

test("long_only 且无杠杆的策略可以上现货模拟盘", () => {
  const verdict = evaluateFollowSpotAdmission(dsl());
  assert.equal(verdict.admitted, true);
  assert.ok(verdict.symbol);
  assert.ok(verdict.timeframe);
});

test("做空与双向策略一律拒绝，不做降级执行", () => {
  // 现货只能做多，这是现货的定义。需求方确认拒绝跟单而不是「只跑多头腿」——只跑一半会
  // 让客户看到的结果与作者策略的真实表现不同，而绩效分成正是按这个残缺版本的盈亏算的。
  for (const direction of ["short_only", "both"]) {
    const verdict = evaluateFollowSpotAdmission(dsl({ direction }));
    assert.equal(verdict.admitted, false, `${direction} 不应被准入`);
    assert.equal(verdict.reason, "direction_not_long_only");
    assert.match(verdict.detail, new RegExp(direction));
  }
});

test("杠杆由 DSL 自己挡住，现货准入不重复检查", () => {
  // V2 与 V3 都把 leverage 固定为 1。在准入里再加一道杠杆检查是够不到的死代码——
  // 一条永远不会触发的守卫看起来和真正起作用的守卫一模一样。
  for (const leverage of [2, 5, 0.5]) {
    const verdict = evaluateFollowSpotAdmission(dsl({ leverage }));
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.reason, "invalid_specification");
    assert.match(verdict.detail, /杠杆固定为 1/);
  }
});

test("规格无法解析时说明原因，不当成「方向不对」", () => {
  // 两者对作者是不同的指引：一个要改策略方向，一个要修规格。
  const verdict = evaluateFollowSpotAdmission({ schemaVersion: 3, name: "坏的" });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "invalid_specification");
  assert.ok(verdict.detail.length > 0);
  assert.equal(evaluateFollowSpotAdmission(null).reason, "invalid_specification");
});

test("判定不改写策略", () => {
  // 降级执行一个策略等于替作者和客户各自改了他们同意的东西。
  const specification = dsl({ direction: "both" });
  const before = JSON.stringify(specification);
  evaluateFollowSpotAdmission(specification);
  assert.equal(JSON.stringify(specification), before);
});
