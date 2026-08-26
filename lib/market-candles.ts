import { fetchPublicMarketJson, publicMarketProviderName } from "./public-market-source.ts";

export type MarketCandleCategory = "crypto" | "forex" | "metals" | "stocks";
export type MarketCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

const yahooSymbols: Record<string, string> = {
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  AUDUSD: "AUDUSD=X",
  USDCAD: "CAD=X",
  USDCHF: "CHF=X",
  NZDUSD: "NZDUSD=X",
  EURJPY: "EURJPY=X",
  GBPJPY: "GBPJPY=X",
  XAUUSD: "GC=F",
  XAGUSD: "SI=F",
};
const binanceIntervals: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
const yahooIntervals: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "1h", "1D": "1d", "1W": "1wk" };
const yahooRanges: Record<string, string> = { "1m": "1d", "5m": "5d", "15m": "1mo", "30m": "1mo", "1H": "3mo", "4H": "6mo", "1D": "2y", "1W": "5y" };

type YahooCandlePayload = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> };
    }>;
  };
};

function cryptoProvider(symbol: string) {
  return `${symbol.replace(/USD$/, "")}USDT`;
}

async function yahooCandles(symbol: string, interval: string, range: string): Promise<MarketCandle[]> {
  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
    {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    },
  );
  if (!response.ok) throw new Error("外部 K 线行情源暂时不可用");
  const payload = await response.json() as YahooCandlePayload;
  const result = payload.chart?.result?.[0];
  const timestamp = result?.timestamp || [];
  const row = result?.indicators?.quote?.[0];
  return timestamp.map((time, index) => ({
    time: time * 1000,
    open: Number(row?.open?.[index] || 0),
    high: Number(row?.high?.[index] || 0),
    low: Number(row?.low?.[index] || 0),
    close: Number(row?.close?.[index] || 0),
    volume: Number(row?.volume?.[index] || 0),
  })).filter((candle) => candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0);
}

export async function getMarketCandles(input: {
  symbol: string;
  category: MarketCandleCategory;
  interval: string;
  before: number;
  limit: number;
}) {
  const symbol = input.symbol.toUpperCase().replace("/", "");
  let candles: MarketCandle[];
  let source = "Yahoo Finance public chart";
  if (input.category === "crypto") {
    const endTime = input.before ? `&endTime=${Math.max(0, input.before - 1)}` : "";
    const { data: rows, base } = await fetchPublicMarketJson<Array<[number, string, string, string, string, string]>>(
      `/api/v3/klines?symbol=${cryptoProvider(symbol)}&interval=${binanceIntervals[input.interval] || "15m"}&limit=${input.limit}${endTime}`,
      6_000,
    );
    candles = rows.map((row) => ({
      time: row[0],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
    source = publicMarketProviderName(base);
  } else {
    const rows = await yahooCandles(
      yahooSymbols[symbol] || symbol,
      yahooIntervals[input.interval] || "15m",
      yahooRanges[input.interval] || "1mo",
    );
    candles = (input.before ? rows.filter((candle) => candle.time < input.before) : rows).slice(-input.limit);
  }
  return {
    symbol,
    interval: input.interval,
    live: candles.length > 0,
    source,
    updatedAt: new Date().toISOString(),
    hasMore: candles.length === input.limit,
    candles,
  };
}

export function unavailableMarketCandles(symbol: string, interval: string, error: unknown) {
  return {
    symbol,
    interval,
    live: false,
    source: "unavailable",
    updatedAt: new Date().toISOString(),
    hasMore: false,
    candles: [] as MarketCandle[],
    error: error instanceof Error ? error.message : "K 线源暂时不可用",
  };
}
