import { fetchPublicMarketJson, publicMarketProviderName } from "./public-market-source.ts";

export type MarketQuoteCategory = "crypto" | "forex" | "metals" | "stocks";

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

type YahooQuotePayload = {
  chart?: {
    result?: Array<{
      meta?: Record<string, unknown>;
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
};

export type MarketQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume: number;
  open: number;
  live: boolean;
  source: string;
  updatedAt: string;
};

function cryptoProvider(symbol: string) {
  return `${symbol.replace(/USD$/, "")}USDT`;
}

async function yahooQuote(symbol: string) {
  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`,
    {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error("外部行情源暂时不可用");
  const payload = await response.json() as YahooQuotePayload;
  const result = payload.chart?.result?.[0];
  const meta = result?.meta || {};
  const row = result?.indicators?.quote?.[0];
  const closes = (row?.close || []).filter((value): value is number => typeof value === "number");
  const price = Number(meta.regularMarketPrice || closes.at(-1) || 0);
  const previous = Number(meta.chartPreviousClose || meta.previousClose || price);
  const high = Number(meta.regularMarketDayHigh || Math.max(
    ...(row?.high || []).filter((value): value is number => typeof value === "number"),
    price,
  ));
  const lowValues = (row?.low || []).filter((value): value is number => typeof value === "number");
  const low = Number(meta.regularMarketDayLow || Math.min(...lowValues, price));
  const volume = Number(meta.regularMarketVolume || (
    row?.volume || []).filter((value): value is number => typeof value === "number").at(-1) || 0);
  return {
    price,
    change: price - previous,
    changePercent: previous ? ((price - previous) / previous) * 100 : 0,
    high,
    low,
    volume,
    open: Number(meta.regularMarketOpen || price),
    live: price > 0,
    source: "Yahoo Finance public chart",
  };
}

export async function getMarketQuote(symbol: string, category: MarketQuoteCategory): Promise<MarketQuote> {
  const normalizedSymbol = symbol.toUpperCase().replace("/", "");
  const updatedAt = new Date().toISOString();
  if (category === "crypto") {
    const { data: row, base } = await fetchPublicMarketJson<{
      lastPrice: string;
      priceChange: string;
      priceChangePercent: string;
      highPrice: string;
      lowPrice: string;
      volume: string;
      quoteVolume: string;
      openPrice: string;
    }>(`/api/v3/ticker/24hr?symbol=${cryptoProvider(normalizedSymbol)}`, 5_000);
    return {
      symbol: normalizedSymbol,
      price: Number(row.lastPrice),
      change: Number(row.priceChange),
      changePercent: Number(row.priceChangePercent),
      high: Number(row.highPrice),
      low: Number(row.lowPrice),
      volume: Number(row.quoteVolume || row.volume),
      open: Number(row.openPrice),
      live: true,
      source: publicMarketProviderName(base),
      updatedAt,
    };
  }
  const provider = yahooSymbols[normalizedSymbol] || normalizedSymbol;
  return { symbol: normalizedSymbol, ...(await yahooQuote(provider)), updatedAt };
}

export function unavailableMarketQuote(symbol: string, error: unknown): MarketQuote & { error: string } {
  return {
    symbol,
    price: 0,
    change: 0,
    changePercent: 0,
    high: 0,
    low: 0,
    volume: 0,
    open: 0,
    live: false,
    source: "unavailable",
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : "行情源暂时不可用",
  };
}
