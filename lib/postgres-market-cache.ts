import type { Pool } from "pg";

import type { HistoricalFundingRate } from "./backtest-engine.ts";
import type { PerpetualExchange } from "./perpetual-market-adapters.ts";
import type { StrategyCandle } from "./strategy-dsl.ts";

function validateMarketKey(exchange: string, symbol: string, timeframe: string) {
  if (!["okx", "binance", "bybit"].includes(exchange)) throw new Error("不支持的交易所");
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error("交易对格式无效");
  if (!["5m", "15m", "1h", "4h", "1d"].includes(timeframe)) throw new Error("K 线周期无效");
}

export async function cachePerpetualMarketData(database: Pool, input: {
  exchange: PerpetualExchange;
  symbol: string;
  timeframe: string;
  candles: StrategyCandle[];
  fundingRates: HistoricalFundingRate[];
}) {
  validateMarketKey(input.exchange, input.symbol, input.timeframe);
  const candles = new Map<number, StrategyCandle>();
  for (const candle of input.candles) candles.set(candle.openTime, candle);
  const fundingRates = new Map<number, HistoricalFundingRate>();
  for (const funding of input.fundingRates) fundingRates.set(funding.time, funding);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    for (const candle of candles.values()) {
      if (!Object.values(candle).every(Number.isFinite)) throw new Error("缓存 K 线包含无效数值");
      await client.query(`
        INSERT INTO market_candles (
          exchange, symbol, timeframe, open_time, close_time,
          open, high, low, close, volume, is_complete, fetched_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, now())
        ON CONFLICT (exchange, symbol, timeframe, open_time) DO UPDATE SET
          close_time = EXCLUDED.close_time,
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          is_complete = true,
          fetched_at = now()
      `, [
        input.exchange,
        input.symbol,
        input.timeframe,
        new Date(candle.openTime),
        new Date(candle.closeTime),
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ]);
    }
    for (const funding of fundingRates.values()) {
      if (!Number.isFinite(funding.time) || !Number.isFinite(funding.rate) || Math.abs(funding.rate) > 0.1) {
        throw new Error("缓存资金费率包含无效数值");
      }
      await client.query(`
        INSERT INTO funding_rates (
          exchange, symbol, funding_time, funding_rate, fetched_at
        ) VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (exchange, symbol, funding_time) DO UPDATE SET
          funding_rate = EXCLUDED.funding_rate,
          fetched_at = now()
      `, [input.exchange, input.symbol, new Date(funding.time), funding.rate]);
    }
    await client.query("COMMIT");
    return { candleCount: candles.size, fundingRateCount: fundingRates.size };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadCachedPerpetualMarketData(database: Pool, input: {
  exchange: PerpetualExchange;
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
}) {
  validateMarketKey(input.exchange, input.symbol, input.timeframe);
  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime) || input.startTime > input.endTime) {
    throw new Error("缓存查询时间范围无效");
  }
  const [candlesResult, fundingResult] = await Promise.all([
    database.query<{
      open_time: Date;
      close_time: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>(`
      SELECT open_time, close_time, open, high, low, close, volume
      FROM market_candles
      WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
        AND open_time >= $4 AND open_time <= $5 AND is_complete = true
      ORDER BY open_time
      LIMIT 30000
    `, [input.exchange, input.symbol, input.timeframe, new Date(input.startTime), new Date(input.endTime)]),
    database.query<{ funding_time: Date; funding_rate: string }>(`
      SELECT funding_time, funding_rate
      FROM funding_rates
      WHERE exchange = $1 AND symbol = $2
        AND funding_time >= $3 AND funding_time <= $4
      ORDER BY funding_time
      LIMIT 10000
    `, [input.exchange, input.symbol, new Date(input.startTime), new Date(input.endTime)]),
  ]);
  return {
    candles: candlesResult.rows.map((row) => ({
      openTime: row.open_time.getTime(),
      closeTime: row.close_time.getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    })),
    fundingRates: fundingResult.rows.map((row) => ({
      time: row.funding_time.getTime(),
      rate: Number(row.funding_rate),
    })),
  };
}
