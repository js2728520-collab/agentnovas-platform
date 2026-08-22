// 回测的行情加载与编排（适配器层）。
//
// 纯计算在 packages/domain/src/backtest-engine.ts。这里只负责取数据和串起来：
// 取 K 线要发真实 HTTP 请求，不属于域层。

import { fetchPublicMarketJson, publicMarketProviderName } from "./public-market-source.ts";
import {
  normalizeBacktestDsl,
  normalizeBacktestOptions,
  runBacktestOnCandles,
  type BacktestOptionsInput,
  type BacktestResult,
  type StrategyDsl,
  type StrategyCandle,
} from "../packages/domain/src/backtest-engine.ts";
import {
  evaluateStrategySmokeTest,
  type StrategySmokeVerdict,
} from "../packages/domain/src/strategy-smoke-test.ts";

export async function loadBacktestCandles(
  specification: Pick<StrategyDsl, "symbol" | "timeframe">,
  limit: number,
): Promise<{ candles: StrategyCandle[]; provider: string }> {
  const { data, base } = await fetchPublicMarketJson<unknown[]>(
    `/api/v3/klines?symbol=${encodeURIComponent(specification.symbol)}&interval=${encodeURIComponent(specification.timeframe)}&limit=${limit}`,
    12_000,
  );
  if (!Array.isArray(data)) throw new Error("历史行情数据格式无效");
  const candles = data.map((row) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error("历史K线字段不完整");
    return {
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    };
  }).filter((candle) => Object.values(candle).every(Number.isFinite));
  if (candles.length < 200) throw new Error("历史K线样本不足 200 根，平台拒绝生成回测结论");
  return { candles, provider: publicMarketProviderName(base) };
}

export async function runHistoricalBacktest(
  rawSpecification: unknown,
  rawOptions: BacktestOptionsInput = {},
): Promise<BacktestResult> {
  const specification = normalizeBacktestDsl(rawSpecification);
  const options = normalizeBacktestOptions(rawOptions);
  const { candles, provider } = await loadBacktestCandles(specification, options.candleLimit);
  return runBacktestOnCandles(specification, candles, { ...options, provider });
}

/**
 * 保存策略前的冒烟回测。
 *
 * 只回答「这条策略能不能跑起来」，不看收益。判定规则在
 * packages/domain/src/strategy-smoke-test.ts，可脱离网络单测。
 *
 * 三种结局分得很清楚：
 * - passed —— 跑完且触发过信号；
 * - failed —— 引擎抛错、触发强平，或跑完一根信号都没有。策略本身的问题；
 * - skipped —— 取不到行情。**不是策略的问题，但也不能当作通过**（INV-6）。
 */
export async function runStrategySmokeTest(rawSpecification: unknown): Promise<StrategySmokeVerdict> {
  let specification;
  let candles: StrategyCandle[];
  try {
    specification = normalizeBacktestDsl(rawSpecification);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "策略规格无法归一化", signals: 0 };
  }
  const options = normalizeBacktestOptions({});
  try {
    ({ candles } = await loadBacktestCandles(specification, options.candleLimit));
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : "历史行情不可用" };
  }
  try {
    const result = await runBacktestOnCandles(specification, candles, { ...options, provider: "smoke_test" });
    return evaluateStrategySmokeTest(result);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "回测引擎执行失败", signals: 0 };
  }
}
