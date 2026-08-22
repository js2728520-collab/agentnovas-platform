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
