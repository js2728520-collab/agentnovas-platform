import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStrategyAdmissionThresholds,
  evaluateStrategyAdmission,
  riskTierFromLevel,
} from "../packages/contracts/src/strategy-admission.ts";
import {
  isStrategyAdmissionFamily,
  looseningsAgainstBaseline,
  normalizeStrategyAdmissionPayload,
  resolveStrategyAdmissionThresholds,
  runStrategyAdmissionTest,
  STRATEGY_ADMISSION_FAMILY,
} from "../lib/strategy-admission-configuration.ts";
import { STRATEGY_ADMISSION } from "../packages/contracts/src/product-parameters.ts";

const passing = (overrides = {}) => ({
  riskTier: "balanced",
  backtestPeriodStart: "2025-01-01T00:00:00.000Z",
  backtestPeriodEnd: "2025-12-31T00:00:00.000Z",
  sampleSize: 42,
  netReturnPct: 12.5,
  maxDrawdownPct: 9,
  paperTradingDays: 0,
  validationLabel: "STANDARD_VERIFIED",
  ...overrides,
});
const failed = (facts) => evaluateStrategyAdmission(facts).failedCheckIds;

test("门槛默认值取自已冻结的 P-05", () => {
  const thresholds = defaultStrategyAdmissionThresholds();
  assert.equal(thresholds.minimumBacktestDays, STRATEGY_ADMISSION.minimumBacktestDays);
  assert.equal(thresholds.minimumTrades, STRATEGY_ADMISSION.minimumTrades);
  assert.deepEqual(thresholds.maximumDrawdownPctByTier, STRATEGY_ADMISSION.maximumDrawdownPctByTier);
  // 修改默认值不得影响已冻结的常量对象。
  thresholds.maximumDrawdownPctByTier.balanced = 99;
  assert.equal(STRATEGY_ADMISSION.maximumDrawdownPctByTier.balanced, 15);
});

test("达标的策略逐项通过", () => {
  const result = evaluateStrategyAdmission(passing());
  assert.equal(result.meetsThresholds, true);
  assert.deepEqual(result.failedCheckIds, []);
  // 门槛通过**不等于**可以上架：人工审核是独立的一关。
  assert.equal(result.requiresManualReview, true);
  // 每条检查都带实际值与门槛值，审核人能核对而不是只看一个布尔。
  const period = result.checks.find((check) => check.id === "backtest_period");
  assert.equal(period.actual, 364);
  assert.equal(period.required, 180);
});

test("逐项门槛各自可以单独失败", () => {
  assert.deepEqual(failed(passing({ backtestPeriodEnd: "2025-03-01T00:00:00.000Z" })), ["backtest_period"]);
  assert.deepEqual(failed(passing({ sampleSize: 29 })), ["trade_sample"]);
  assert.deepEqual(failed(passing({ maxDrawdownPct: 15.1 })), ["max_drawdown"]);
  // 回撤按档位取值：同样 18% 的回撤，激进档过、平衡档不过。
  assert.deepEqual(failed(passing({ maxDrawdownPct: 18, riskTier: "aggressive" })), []);
  assert.deepEqual(failed(passing({ maxDrawdownPct: 18, riskTier: "balanced" })), ["max_drawdown"]);
  // 回撤以绝对值判定：库里存成 -9 还是 9 都表示回撤 9%。
  assert.deepEqual(failed(passing({ maxDrawdownPct: -9 })), []);
});

test("净收益必须为正——0% 不算", () => {
  // 确认值 minimumNetReturnPct=0 表达的是「收益为正」，而 0% 不是正数。
  assert.equal(STRATEGY_ADMISSION.minimumNetReturnPct, 0);
  assert.deepEqual(failed(passing({ netReturnPct: 0 })), ["net_return"]);
  assert.deepEqual(failed(passing({ netReturnPct: -0.1 })), ["net_return"]);
  assert.deepEqual(failed(passing({ netReturnPct: 0.01 })), []);
});

test("降级或未验证的回测不能作为准入依据", () => {
  // INV-6：降级不得被记录为外部验证已通过。
  assert.deepEqual(failed(passing({ validationLabel: "UNVERIFIED" })), ["validation_label"]);
  assert.deepEqual(failed(passing({ validationLabel: "" })), ["validation_label"]);
  assert.deepEqual(failed(passing({ validationLabel: "DEEP_VERIFIED" })), []);
});

test("缺失或损坏的事实一律判为不达标，不是跳过", () => {
  // 数值缺失时「跳过这条检查」等于放行。方向必须指向拒绝。
  assert.deepEqual(failed(passing({ sampleSize: Number.NaN })), ["trade_sample"]);
  assert.deepEqual(failed(passing({ netReturnPct: Number.NaN })), ["net_return"]);
  assert.deepEqual(failed(passing({ maxDrawdownPct: Number.NaN })), ["max_drawdown"]);

  // 区间无法解析时记 -1，让审核人一眼看出这不是「区间太短」。
  const broken = evaluateStrategyAdmission(passing({ backtestPeriodStart: "not-a-date" }));
  assert.deepEqual(broken.failedCheckIds, ["backtest_period"]);
  assert.equal(broken.checks.find((check) => check.id === "backtest_period").actual, -1);
  // 结束早于开始同样判为损坏。
  assert.deepEqual(failed(passing({
    backtestPeriodStart: "2025-12-31T00:00:00.000Z", backtestPeriodEnd: "2025-01-01T00:00:00.000Z",
  })), ["backtest_period"]);
});

test("未知风险等级归入最严格档位", () => {
  // 归入宽松档等于让一个拼错的字段值放宽风控门槛。
  assert.equal(riskTierFromLevel("high"), "aggressive");
  assert.equal(riskTierFromLevel("medium"), "balanced");
  assert.equal(riskTierFromLevel("low"), "conservative");
  assert.equal(riskTierFromLevel("MEDIUM"), "balanced");
  assert.equal(riskTierFromLevel("不存在"), "conservative");
  assert.equal(riskTierFromLevel(null), "conservative");
});

test("配置只能收紧，不能放宽已冻结的 P-05", () => {
  const baseline = defaultStrategyAdmissionThresholds();
  const family = (payload) => ({ ...STRATEGY_ADMISSION_FAMILY, payload });

  const stricter = { ...baseline, minimumBacktestDays: 365, maximumDrawdownPctByTier: { conservative: 5, balanced: 8, aggressive: 12 } };
  assert.deepEqual(looseningsAgainstBaseline(stricter), []);
  assert.equal(runStrategyAdmissionTest(family(stricter)).result, "passed");

  // 没有这条断言，运维就能把回撤上限从 15% 调到 60%，让一批本该被拒的策略进入广场，
  // 而整个 draft/test/approve 流程会显示一切正常。
  const looser = { ...baseline, maximumDrawdownPctByTier: { conservative: 10, balanced: 60, aggressive: 20 } };
  const test1 = runStrategyAdmissionTest(family(looser));
  assert.equal(test1.result, "failed");
  assert.deepEqual(test1.failedChecks, ["no_loosening_against_frozen_baseline"]);
  assert.deepEqual(looseningsAgainstBaseline(looser), ["maximumDrawdownPctByTier.balanced"]);

  assert.deepEqual(looseningsAgainstBaseline({ ...baseline, minimumBacktestDays: 90 }), ["minimumBacktestDays"]);
  assert.deepEqual(looseningsAgainstBaseline({ ...baseline, minimumTrades: 5 }), ["minimumTrades"]);
  // 人工审核不可被配置关掉：它是 P-05 里唯一一道非数值的关。
  assert.deepEqual(looseningsAgainstBaseline({ ...baseline, requiresManualReview: false }), ["requiresManualReview"]);
});

test("消费端同向：即便放宽的版本被激活，也不会真的放宽", () => {
  // 测试器挡的是「不该被批准」，消费端挡的是「已经被批准了怎么办」。
  const resolved = resolveStrategyAdmissionThresholds({
    ...defaultStrategyAdmissionThresholds(),
    minimumBacktestDays: 30,
    minimumTrades: 1,
    maximumDrawdownPctByTier: { conservative: 90, balanced: 90, aggressive: 90 },
    requiresManualReview: false,
  });
  assert.equal(resolved.minimumBacktestDays, 180);
  assert.equal(resolved.minimumTrades, 30);
  assert.deepEqual(resolved.maximumDrawdownPctByTier, { conservative: 10, balanced: 15, aggressive: 20 });
  assert.equal(resolved.requiresManualReview, true);

  // 收紧的配置正常生效。
  const tightened = resolveStrategyAdmissionThresholds({
    ...defaultStrategyAdmissionThresholds(), minimumTrades: 100,
  });
  assert.equal(tightened.minimumTrades, 100);

  // 非法或缺失的配置回落到已冻结的 P-05，而不是无门槛。
  for (const broken of [null, undefined, "not-an-object", {}, { minimumTrades: 5 }]) {
    assert.deepEqual(resolveStrategyAdmissionThresholds(broken), defaultStrategyAdmissionThresholds());
  }
});

test("payload 必须字段齐全，不允许部分覆盖", () => {
  const baseline = defaultStrategyAdmissionThresholds();
  // 缺字段时「沿用默认」会让同一份配置在不同版本的代码上得到不同门槛。
  assert.throws(() => normalizeStrategyAdmissionPayload({ minimumTrades: 50 }),
    (error) => error.code === "CONFIGURATION_FAMILY_SCHEMA_INVALID");
  assert.throws(() => normalizeStrategyAdmissionPayload({ ...baseline, extra: 1 }),
    (error) => { assert.deepEqual(error.details.fields, ["extra"]); return true; });
  assert.throws(() => normalizeStrategyAdmissionPayload({
    ...baseline, maximumDrawdownPctByTier: { conservative: 10, balanced: 15 },
  }), (error) => error.code === "CONFIGURATION_FAMILY_SCHEMA_INVALID");
  assert.throws(() => normalizeStrategyAdmissionPayload({ ...baseline, requiresManualReview: "true" }),
    (error) => { assert.deepEqual(error.details.fields, ["requiresManualReview"]); return true; });

  assert.deepEqual(normalizeStrategyAdmissionPayload(baseline), baseline);
  assert.equal(isStrategyAdmissionFamily({ ...STRATEGY_ADMISSION_FAMILY }), true);
  assert.equal(isStrategyAdmissionFamily({ ...STRATEGY_ADMISSION_FAMILY, schemaVersion: 2 }), false);
  assert.equal(isStrategyAdmissionFamily({ ...STRATEGY_ADMISSION_FAMILY, audience: "operations" }), false);
});
