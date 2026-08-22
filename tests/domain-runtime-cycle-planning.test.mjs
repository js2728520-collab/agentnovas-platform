import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRuntimeSpotCandles,
  deterministicCycleId,
  nextPollAt,
  resolveFundingWindowLimit,
  selectCycleCandle,
} from "../packages/domain/src/runtime/cycle-planning.ts";
import {
  classifyExplanationFailure,
  explanationRetryDelayMs,
} from "../packages/domain/src/runtime/explanation-retry.ts";

// 决策轮的周期规划。
//
// 「这一轮作用在哪根 K 线上」是决策轮最基础的判定，下游的快照、决策记录、
// 订单意图、幂等键全挂在它上面。这套逻辑此前在现货与永续两条路径里各写了一份。

const hour = 3_600_000;
const bar = (index) => ({
  openTime: index * hour,
  closeTime: (index + 1) * hour - 1,
  open: 100, high: 101, low: 99, close: 100, volume: 10,
});
const series = (count) => Array.from({ length: count }, (_, index) => bar(index));

test("首次决策取最新一根已收盘 K 线", () => {
  const candles = series(5);
  const cycle = selectCycleCandle(candles, null);
  assert.equal(cycle.selected.closeTime, candles.at(-1).closeTime);
  assert.equal(cycle.evaluationCandles.length, 5, "指标需要全部历史");
  assert.equal(cycle.hasBacklog, false);
});

test("后续决策取第一根比上次更晚收盘的 K 线", () => {
  const candles = series(5);
  const cycle = selectCycleCandle(candles, candles[1].closeTime);
  assert.equal(cycle.selected.closeTime, candles[2].closeTime);
  // 喂给引擎的是「从头到 selected」，不是从上次之后开始——指标要历史。
  assert.deepEqual(cycle.evaluationCandles.map((c) => c.closeTime),
    candles.slice(0, 3).map((c) => c.closeTime));
});

test("落后时报告 backlog，跟上时不报", () => {
  const candles = series(5);
  assert.equal(selectCycleCandle(candles, candles[1].closeTime).hasBacklog, true);
  assert.equal(selectCycleCandle(candles, candles[3].closeTime).hasBacklog, false);
});

test("没有更新的 K 线时返回 null，由调用方推迟租约", () => {
  const candles = series(5);
  assert.equal(selectCycleCandle(candles, candles.at(-1).closeTime), null);
  assert.equal(selectCycleCandle(candles, candles.at(-1).closeTime + 1), null);
  assert.equal(selectCycleCandle([], null), null);
});

test("上次处理过的那根不会被重复选中", () => {
  // 判定是严格大于：等于意味着这根已经产生过决策轮了。
  const candles = series(3);
  const cycle = selectCycleCandle(candles, candles[0].closeTime);
  assert.notEqual(cycle.selected.closeTime, candles[0].closeTime);
});

test("同一部署在同一根 K 线上算出同一个周期 id", () => {
  // INV-8：相同 card/candle/contract 的重试必须返回同一决策轮。
  assert.equal(deterministicCycleId("dep-1", 1_755_840_000_000), "runtime:dep-1:1755840000000");
  assert.equal(deterministicCycleId("dep-1", 1_755_840_000_000), deterministicCycleId("dep-1", 1_755_840_000_000));
  assert.notEqual(deterministicCycleId("dep-1", 1), deterministicCycleId("dep-2", 1));
});

test("落后时 1 秒后追赶，跟上后按 15 秒轮询", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  assert.equal(nextPollAt(now, true).toISOString(), "2026-08-22T00:00:01.000Z");
  assert.equal(nextPollAt(now, false).toISOString(), "2026-08-22T00:00:15.000Z");
});

test("资金费率条数按结算周期估算，并有上下限", () => {
  const base = { startTime: 0, fundingIntervalHours: 8 };
  // 24 小时 / 8 小时 = 3 个周期，加 10 条余量。
  assert.equal(resolveFundingWindowLimit({ ...base, endTime: 24 * hour }), 13);
  // 区间为零也至少要 1 条——交易所接口不接受 limit=0。
  assert.equal(resolveFundingWindowLimit({ ...base, endTime: 0 }), 10);
  // 区间异常时封顶，防止打爆请求。
  assert.equal(resolveFundingWindowLimit({ ...base, endTime: 10_000_000 * hour }), 10_000);
});

test("现货 K 线严格校验：不合格就抛，不补齐也不跳过", () => {
  assert.doesNotThrow(() => assertRuntimeSpotCandles(series(3)));
  assert.throws(() => assertRuntimeSpotCandles(series(1)), /缺少足够的完整 K 线/);

  const cases = {
    "价格为零": { close: 0 },
    "价格为负": { low: -1 },
    "成交量为负": { volume: -1 },
    "非有限数字": { high: Number.NaN },
    "开收时间倒置": { openTime: 9 * hour },
  };
  for (const [label, patch] of Object.entries(cases)) {
    const candles = series(3);
    candles[2] = { ...candles[2], ...patch };
    assert.throws(() => assertRuntimeSpotCandles(candles), /未通过严格校验/, label);
  }
});

test("现货 K 线必须严格递增，重复或乱序会被拒绝", () => {
  // 一根坏 K 线流进引擎，产出的是一个看起来正常、实际没有依据的决策。
  const duplicated = series(3);
  duplicated[2] = { ...duplicated[1] };
  assert.throws(() => assertRuntimeSpotCandles(duplicated), /未通过严格校验/);

  const reordered = series(3);
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.throws(() => assertRuntimeSpotCandles(reordered), /未通过严格校验/);
});

test("解释任务失败按消息分类", () => {
  assert.equal(classifyExplanationFailure("调用超时"), "RUNTIME_EXPLANATION_TIMEOUT");
  assert.equal(classifyExplanationFailure("运行时解释 Prompt 版本与任务快照不一致"),
    "RUNTIME_EXPLANATION_PROMPT_MISMATCH");
  assert.equal(classifyExplanationFailure("模型返回结构错误"), "RUNTIME_EXPLANATION_FAILED");
});

test("解释任务退避 15 秒起翻倍，封顶 5 分钟", () => {
  assert.equal(explanationRetryDelayMs(1), 15_000);
  assert.equal(explanationRetryDelayMs(2), 30_000);
  assert.equal(explanationRetryDelayMs(5), 240_000);
  assert.equal(explanationRetryDelayMs(6), 300_000);
  assert.equal(explanationRetryDelayMs(50), 300_000, "封顶后不再增长");
  assert.equal(explanationRetryDelayMs(0), 15_000, "attemptCount 异常时不应倒退");
});
