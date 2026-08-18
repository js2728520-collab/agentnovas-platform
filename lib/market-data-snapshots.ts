import type { Pool, PoolClient } from "pg";

import type { HistoricalFundingRate } from "./backtest-engine.ts";
import type { PerpetualExchange } from "./perpetual-market-adapters.ts";
import type { StrategyCandle } from "./strategy-dsl.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hashMarketDataSeries(
  candles: StrategyCandle[],
  fundingRates: HistoricalFundingRate[],
) {
  const candleSeries = [...candles]
    .sort((left, right) => left.openTime - right.openTime)
    .map(item => [item.openTime, item.closeTime, item.open, item.high, item.low, item.close, item.volume]);
  const fundingSeries = [...fundingRates]
    .sort((left, right) => left.time - right.time)
    .map(item => [item.time, item.rate]);
  const [candleSha256, fundingSha256] = await Promise.all([
    sha256(JSON.stringify(candleSeries)),
    sha256(JSON.stringify(fundingSeries)),
  ]);
  return {
    candleSha256,
    fundingSha256,
    datasetSha256: await sha256(`${candleSha256}:${fundingSha256}`),
  };
}

export async function saveMarketDataSnapshot(database: Queryable, input: {
  sourceType: "research_run" | "runtime_cycle";
  sourceId: string;
  exchangeAccountId: string;
  exchange: PerpetualExchange;
  instrumentId: string;
  symbol: string;
  timeframe: string;
  candles: StrategyCandle[];
  fundingRates: HistoricalFundingRate[];
  instrumentRules: Record<string, unknown>;
  feeSchedule: Record<string, unknown>;
  dataQuality: Record<string, unknown>;
}) {
  if (!input.candles.length) throw new Error("市场数据快照不能缺少 K 线");
  const hashes = await hashMarketDataSeries(input.candles, input.fundingRates);
  const orderedCandles = [...input.candles].sort((left, right) => left.openTime - right.openTime);
  const id = crypto.randomUUID();
  const result = await database.query<{ id: string; dataset_sha256: string }>(`
    WITH inserted AS (
      INSERT INTO market_data_snapshots (
        id, source_type, source_id, exchange_account_id, exchange,
        instrument_id, symbol, timeframe, data_start, data_end,
        candle_count, candle_sha256, funding_rate_count, funding_sha256,
        dataset_sha256, instrument_rules_json, fee_schedule_json, data_quality_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb
      )
      ON CONFLICT (source_type, source_id) DO NOTHING
      RETURNING id, dataset_sha256
    )
    SELECT id, dataset_sha256 FROM inserted
    UNION ALL
    SELECT id, dataset_sha256 FROM market_data_snapshots
    WHERE source_type = $2 AND source_id = $3
    LIMIT 1
  `, [
    id,
    input.sourceType,
    input.sourceId,
    input.exchangeAccountId,
    input.exchange,
    input.instrumentId,
    input.symbol,
    input.timeframe,
    new Date(orderedCandles[0].openTime),
    new Date(orderedCandles.at(-1)!.closeTime),
    orderedCandles.length,
    hashes.candleSha256,
    input.fundingRates.length,
    hashes.fundingSha256,
    hashes.datasetSha256,
    JSON.stringify(input.instrumentRules),
    JSON.stringify(input.feeSchedule),
    JSON.stringify(input.dataQuality),
  ]);
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error("市场数据快照保存失败");
  if (snapshot.dataset_sha256 !== hashes.datasetSha256) {
    throw new Error("同一任务的数据快照已存在且哈希不一致");
  }
  return { id: snapshot.id, ...hashes };
}
