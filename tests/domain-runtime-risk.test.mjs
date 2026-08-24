import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeRiskState } from "../packages/domain/src/runtime/risk-state.ts";
import { applyDeploymentRiskOverrides } from "../packages/domain/src/runtime/deployment-overrides.ts";
import { evaluateStrategyRuntimeCycle } from "../packages/domain/src/strategy-runtime-engine.ts";

// 运行时风控：读数归一化 + 部署级覆盖。
//
// 这两块此前埋在 lib/strategy-runtime-worker.ts 里，只能通过起数据库跑整轮决策
// 才能验证。它们决定「能不能开仓」和「开多大」，是客户实际承担的风险边界。

// ---------------------------------------------------------------------------
// 风控读数：失败安全
// ---------------------------------------------------------------------------

test("完好读数原样通过", () => {
  const state = resolveRuntimeRiskState({
    drawdownPct: 5.5, dailyLossPct: 1.25, consecutiveLosses: 2, halted: false,
  });
  assert.deepEqual(state, {
    drawdownPct: 5.5, dailyLossPct: 1.25, consecutiveLosses: 2, halted: false, unavailableFields: [],
  });
});

test("字段缺失按 0 处理，不算不可用", () => {
  // 0007 号迁移给 risk_state_json 的默认值包含全部三个字段且列是 NOT NULL，
  // 所以缺失只可能出现在从未写入的新部署上——新部署的回撤确实是 0。
  const state = resolveRuntimeRiskState({});
  assert.deepEqual(state.unavailableFields, []);
  assert.equal(state.drawdownPct, 0);
  assert.equal(state.halted, false);
});

test("读数损坏时标记不可用，而不是猜 0", () => {
  // 此前的写法是 Number.isFinite(x) ? Math.max(x, 0) : 0。
  // 回撤取 0 等于「账户从未亏损」，风控因此放行开仓——读数越坏越容易开仓。
  // 注意 [] 和 false：Number() 会把它们变成 0，靠 Number.isFinite 单独判断挡不住。
  for (const bad of [Number.NaN, Infinity, -Infinity, "abc", "", "  ", {}, [], false, true]) {
    const state = resolveRuntimeRiskState({ drawdownPct: bad });
    assert.deepEqual(state.unavailableFields, ["drawdownPct"], `${String(bad)} 应被判为不可用`);
  }
});

test("连续亏损次数必须是整数", () => {
  assert.deepEqual(resolveRuntimeRiskState({ consecutiveLosses: 2.5 }).unavailableFields,
    ["consecutiveLosses"]);
  assert.deepEqual(resolveRuntimeRiskState({ consecutiveLosses: 3 }).unavailableFields, []);
});

test("多个字段同时损坏时全部记录，且顺序稳定", () => {
  const state = resolveRuntimeRiskState({
    drawdownPct: Number.NaN, dailyLossPct: "x", consecutiveLosses: 1,
  });
  assert.deepEqual(state.unavailableFields, ["dailyLossPct", "drawdownPct"]);
});

test("负值夹到 0，不算损坏", () => {
  // 权益高于峰值时回撤算出来可能是极小的负数，这是舍入不是损坏。
  const state = resolveRuntimeRiskState({ drawdownPct: -0.0001 });
  assert.equal(state.drawdownPct, 0);
  assert.deepEqual(state.unavailableFields, []);
});

test("halted 只认显式 true，且与读数损坏分开表达", () => {
  assert.equal(resolveRuntimeRiskState({ halted: "true" }).halted, false);
  assert.equal(resolveRuntimeRiskState({ halted: 1 }).halted, false);
  assert.equal(resolveRuntimeRiskState({ halted: true }).halted, true);
  // 熔断是风控生效，读数损坏是风控失效，运营端需要能区分这两件事。
  const broken = resolveRuntimeRiskState({ drawdownPct: Number.NaN });
  assert.equal(broken.halted, false);
  assert.deepEqual(broken.unavailableFields, ["drawdownPct"]);
});

// ---------------------------------------------------------------------------
// 引擎：读数不可用时拒绝开仓，但不挡平仓
// ---------------------------------------------------------------------------

const hour = 3_600_000;
const dsl = {
  schemaVersion: 3,
  name: "运行时突破",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: { long: {
    entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
    exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
    stopLossPct: 2,
    takeProfitPct: 4,
  } },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

function candles(last) {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * hour,
    closeTime: (index + 1) * hour - 1,
    open: 100, high: 101, low: 99, close: 100, volume: 100,
  }));
  rows[29] = { ...rows[29], ...last };
  return rows;
}

const evaluate = (overrides) => {
  const input = {
    deploymentId: "deployment-a",
    strategyVersionId: "version-a",
    dsl,
    mode: "paper",
    position: null,
    ...overrides,
  };
  const rows = input.candles;
  return evaluateStrategyRuntimeCycle({
    ...input,
    marketData: input.marketData ?? {
      evaluatedAt: rows.at(-1).closeTime + 1,
      latestClosedAt: rows.at(-1).closeTime,
      timeframe: "1h",
    },
  });
};

test("读数完好时突破照常开仓", () => {
  const result = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0 }),
  });
  assert.equal(result.decision.action, "enter_long");
  assert.equal(result.decision.riskApproved, true);
});

test("读数不可用时拒绝开仓，并写明是哪个字段", () => {
  const result = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: Number.NaN }),
  });
  assert.equal(result.decision.riskApproved, false);
  assert.ok(result.decision.rejectionReasons.some((reason) => reason.includes("风控读数不可用")),
    `实际拒绝理由：${JSON.stringify(result.decision.rejectionReasons)}`);
  assert.ok(result.decision.rejectionReasons.some((reason) => reason.includes("drawdownPct")));
  assert.equal(result.orderIntent, null, "不可信读数下不得产生订单意图");
});

test("读数不可用不会被误报成熔断", () => {
  // 运营端看到「已触发熔断」和「读数坏了」要做的事完全不同。
  const result = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: Number.NaN }),
  });
  assert.equal(result.decision.rejectionReasons.includes("运行部署已触发熔断"), false);
});

test("读数不可用不挡平仓——客户不会被困在仓位里", () => {
  // 这是选择失败安全的前提：引擎里所有风控检查都只作用于开仓，
  // riskApproved = action === "exit" || action === "hold" || 无拒绝理由。
  const result = evaluate({
    candles: candles({ open: 100, close: 96, low: 95 }),
    position: { side: "long", entryPrice: 100, quantity: 1 },
    riskState: resolveRuntimeRiskState({ drawdownPct: Number.NaN, dailyLossPct: "坏了" }),
  });
  assert.equal(result.decision.action, "exit");
  assert.equal(result.decision.riskApproved, true, "平仓必须无条件放行");
  assert.ok(result.orderIntent, "平仓意图必须照常产生");
});

test("风控证据里带着损坏字段，决策可追溯", () => {
  const result = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ dailyLossPct: Infinity }),
  });
  const riskEvent = result.events.find((event) => event.role === "risk");
  assert.deepEqual(riskEvent.evidence.riskState.unavailableFields, ["dailyLossPct"]);
});

// ---------------------------------------------------------------------------
// 部署级覆盖：只能收紧
// ---------------------------------------------------------------------------

const baseSpec = {
  ...dsl,
  legs: { long: { ...dsl.legs.long }, short: { ...dsl.legs.long, stopLossPct: 3 } },
};

test("覆盖更严格时生效", () => {
  const tightened = applyDeploymentRiskOverrides(baseSpec, { positionSizePct: 3, stopLossPct: 1 });
  assert.equal(tightened.risk.positionSizePct, 3);
  assert.equal(tightened.legs.long.stopLossPct, 1);
  assert.equal(tightened.legs.short.stopLossPct, 1);
});

test("覆盖更宽松时被忽略——客户上限不能被策略突破", () => {
  const attempted = applyDeploymentRiskOverrides(baseSpec, { positionSizePct: 99, stopLossPct: 50 });
  assert.equal(attempted.risk.positionSizePct, 5, "不得放宽仓位上限");
  assert.equal(attempted.legs.long.stopLossPct, 2, "不得放宽止损");
  assert.equal(attempted.legs.short.stopLossPct, 3);
});

test("没有覆盖时原值不动", () => {
  const untouched = applyDeploymentRiskOverrides(baseSpec, { positionSizePct: null, stopLossPct: null });
  assert.equal(untouched.risk.positionSizePct, 5);
  assert.equal(untouched.legs.long.stopLossPct, 2);
  assert.equal(untouched.legs.short.stopLossPct, 3);
});

test("只有单边策略时不会凭空造出另一边", () => {
  const longOnly = applyDeploymentRiskOverrides({ ...dsl, legs: { long: dsl.legs.long } },
    { positionSizePct: 1, stopLossPct: 1 });
  assert.deepEqual(Object.keys(longOnly.legs), ["long"]);
});

test("覆盖不修改原规格对象", () => {
  const before = JSON.stringify(baseSpec);
  applyDeploymentRiskOverrides(baseSpec, { positionSizePct: 1, stopLossPct: 1 });
  assert.equal(JSON.stringify(baseSpec), before);
});

test("行情源绑定分叉时拒绝开仓，理由与熔断、读数损坏各自独立", () => {
  // 分叉意味着同一决策轮的共享叙述会被拿去解释两份不同的行情（ADR-0025）。
  const result = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0 }),
    sourceBinding: { consistent: false },
  });
  assert.equal(result.decision.riskApproved, false);
  assert.ok(result.decision.rejectionReasons.includes("行情源绑定分叉，禁止新开仓"),
    `实际拒绝理由：${JSON.stringify(result.decision.rejectionReasons)}`);
  assert.equal(result.orderIntent, null);

  // 运营端看到这三种情况要做的事完全不同，合并成一个标志就查不出原因。
  assert.equal(result.decision.rejectionReasons.includes("运行部署已触发熔断"), false);
  assert.ok(!result.decision.rejectionReasons.some((reason) => reason.includes("风控读数不可用")));
});

test("绑定分叉不挡平仓——客户不会被困在仓位里", () => {
  const result = evaluate({
    candles: candles({ open: 100, close: 96, low: 95 }),
    position: { side: "long", entryPrice: 100, quantity: 1 },
    riskState: resolveRuntimeRiskState({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0 }),
    sourceBinding: { consistent: false },
  });
  assert.equal(result.decision.action, "exit");
  assert.equal(result.decision.riskApproved, true);
  assert.ok(result.orderIntent, "离场意图必须照常产生");
});

test("一致时照常开仓；省略该字段视为一致", () => {
  const consistent = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0 }),
    sourceBinding: { consistent: true },
  });
  assert.equal(consistent.decision.action, "enter_long");
  assert.equal(consistent.decision.riskApproved, true);

  // 省略不等于「查过且不一致」。调用方忘了传就静默停掉所有开仓，是比放行更难发现的故障。
  const omitted = evaluate({
    candles: candles({ high: 112, close: 111 }),
    riskState: resolveRuntimeRiskState({ drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0 }),
  });
  assert.equal(omitted.decision.riskApproved, true);
});
