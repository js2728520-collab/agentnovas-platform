import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBacktestDsl, runBacktestOnCandles } from "../packages/domain/src/backtest-engine.ts";
import { evaluateStrategySmokeTest } from "../packages/domain/src/strategy-smoke-test.ts";

// DSL → 回测引擎的随机化测试。
//
// strategy-dsl.ts(949) + backtest-engine.ts(662) 都在域层、纯函数、零 I/O——
// 这是做随机化测试的理想条件，但此前只有 10 个举例式测试。举例式测试只覆盖
// 想得到的组合；「某个规则组合会让引擎抛异常」这种问题要等客户踩到才发现。
//
// 这里的目标不是找收益异常，是找**崩溃**：任意合法 DSL + 任意合法 K 线，
// 引擎都必须跑完并给出结构完好的结果。
//
// PRNG 用固定种子推进，失败时打印种子即可复现。

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, items) => items[Math.floor(rng() * items.length) % items.length];
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const num = (rng, min, max, decimals = 2) => Number((min + rng() * (max - min)).toFixed(decimals));

function randomRule(rng) {
  switch (pick(rng, [
    "ema_cross", "rsi_threshold", "channel_breakout", "volume_ratio", "adx_threshold",
    "bollinger_band", "atr_volatility", "ema_alignment", "price_ema", "momentum", "candle_direction",
  ])) {
    case "ema_cross": {
      const fastPeriod = int(rng, 2, 30);
      return { type: "ema_cross", fastPeriod, slowPeriod: fastPeriod + int(rng, 1, 40), direction: pick(rng, ["bullish", "bearish"]) };
    }
    case "rsi_threshold":
      return { type: "rsi_threshold", period: int(rng, 2, 40), operator: pick(rng, ["lt", "lte", "gte", "gt"]), value: num(rng, 5, 95) };
    case "channel_breakout":
      return { type: "channel_breakout", period: int(rng, 2, 60), direction: pick(rng, ["above", "below"]) };
    case "volume_ratio":
      return { type: "volume_ratio", period: int(rng, 2, 40), operator: pick(rng, ["lte", "gte"]), value: num(rng, 0.1, 5) };
    case "adx_threshold":
      return { type: "adx_threshold", period: int(rng, 2, 40), operator: pick(rng, ["lte", "gte"]), value: num(rng, 5, 60) };
    case "bollinger_band":
      return { type: "bollinger_band", period: int(rng, 5, 60), stdDev: num(rng, 0.5, 4, 1), band: pick(rng, ["upper", "lower"]), operator: pick(rng, ["above", "below", "gte", "lte"]) };
    case "atr_volatility":
      return { type: "atr_volatility", period: int(rng, 2, 40), operator: pick(rng, ["lte", "gte"]), valuePct: num(rng, 0.1, 10) };
    case "ema_alignment": {
      const first = int(rng, 2, 20);
      const second = first + int(rng, 1, 20);
      return { type: "ema_alignment", periods: [first, second, second + int(rng, 1, 30)], direction: pick(rng, ["bullish", "bearish"]) };
    }
    case "price_ema":
      return { type: "price_ema", period: int(rng, 2, 60), operator: pick(rng, ["above", "below"]) };
    case "momentum":
      return { type: "momentum", period: int(rng, 2, 40), operator: pick(rng, ["lte", "gte"]), valuePct: num(rng, -10, 10) };
    default:
      return { type: "candle_direction", direction: pick(rng, ["bullish", "bearish"]) };
  }
}

function randomDsl(rng) {
  // 取值范围照抄 normalizeStrategyDsl 的实际边界，别猜：
  // stopLoss 0.1–20、takeProfit 0.1–30、positionPct 0.1–30、maxDrawdown 1–50、
  // dailyLossLimit 0.5–20、consecutiveLossLimit 1–10（整数），
  // 且 stopLossPct 必须严格小于 maxDrawdownPct。
  const maxDrawdownPct = num(rng, 2, 50);
  const stopLossPct = num(rng, 0.1, Math.min(20, maxDrawdownPct - 0.1));
  return {
    schemaVersion: 1,
    name: `随机策略-${int(rng, 1, 99999)}`,
    symbol: pick(rng, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
    timeframe: pick(rng, ["5m", "15m", "1h", "4h", "1d"]),
    side: "long_only",
    entry: { all: Array.from({ length: int(rng, 1, 4) }, () => randomRule(rng)) },
    exit: {
      any: Array.from({ length: int(rng, 0, 4) }, () => randomRule(rng)),
      stopLossPct,
      takeProfitPct: num(rng, 0.1, 30),
    },
    risk: {
      positionPct: num(rng, 0.1, 30),
      maxDrawdownPct,
      dailyLossLimitPct: num(rng, 0.5, 20),
      consecutiveLossLimit: int(rng, 1, 10),
    },
  };
}

/** 随机游走 K 线：严格递增、全正、high/low 包住 open/close。 */
function randomCandles(rng, count) {
  const rows = [];
  let price = 100 + rng() * 900;
  const step = 3_600_000;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = Math.max(0.01, open * (1 + (rng() - 0.5) * 0.08));
    const high = Math.max(open, close) * (1 + rng() * 0.02);
    const low = Math.max(0.005, Math.min(open, close) * (1 - rng() * 0.02));
    rows.push({
      openTime: index * step,
      open, high, low, close,
      volume: rng() * 1_000 + 1,
      closeTime: (index + 1) * step - 1,
    });
    price = close;
  }
  return rows;
}

test("任意合法 DSL 都能通过归一化", () => {
  const rng = mulberry32(20260822);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const dsl = randomDsl(rng);
    assert.doesNotThrow(() => normalizeBacktestDsl(dsl), `第 ${iteration} 次：${JSON.stringify(dsl)}`);
  }
});

test("任意合法 DSL 在任意随机行情上都跑得完，且结果结构完好", async () => {
  // 这是这批测试的核心断言：引擎不许崩。
  const rng = mulberry32(19700101);
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const dsl = randomDsl(rng);
    const candles = randomCandles(rng, int(rng, 220, 400));
    let result;
    try {
      result = await runBacktestOnCandles(dsl, candles, { provider: "property_test" });
    } catch (error) {
      assert.fail(`第 ${iteration} 次抛异常：${error?.message}\nDSL=${JSON.stringify(dsl)}`);
    }
    for (const [field, value] of Object.entries({
      netReturnPct: result.netReturnPct,
      maxDrawdownPct: result.maxDrawdownPct,
      winRatePct: result.winRatePct,
      finalEquityUsdt: result.finalEquityUsdt,
    })) {
      assert.ok(Number.isFinite(value), `第 ${iteration} 次 ${field} 不是有限数：${value}`);
    }
    assert.ok(Number.isSafeInteger(result.sampleSize) && result.sampleSize >= 0,
      `第 ${iteration} 次 sampleSize 无效：${result.sampleSize}`);
    assert.ok(result.maxDrawdownPct >= 0, `第 ${iteration} 次回撤为负：${result.maxDrawdownPct}`);
  }
});

test("平坦行情下引擎同样不崩", async () => {
  // 随机游走覆盖不到的退化输入：价格完全不动，多数指标会退化或除零。
  const flat = Array.from({ length: 250 }, (_, index) => ({
    openTime: index * 3_600_000,
    open: 100, high: 100, low: 100, close: 100, volume: 1,
    closeTime: (index + 1) * 3_600_000 - 1,
  }));
  const rng = mulberry32(7);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const dsl = randomDsl(rng);
    const result = await runBacktestOnCandles(dsl, flat, { provider: "property_test" });
    assert.ok(Number.isFinite(result.netReturnPct), `平坦行情第 ${iteration} 次收益不是有限数`);
  }
});

test("冒烟判定对任意回测结果都给出明确结论", async () => {
  const rng = mulberry32(31337);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const dsl = randomDsl(rng);
    const result = await runBacktestOnCandles(dsl, randomCandles(rng, 240), { provider: "property_test" });
    const verdict = evaluateStrategySmokeTest(result);
    assert.ok(["passed", "failed", "skipped"].includes(verdict.status));
    // 零信号必须被判为不通过——惰性策略不是能跑的策略。
    if (result.sampleSize === 0) assert.equal(verdict.status, "failed");
  }
});
