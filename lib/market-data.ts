import { getPublicMarketCandles, getPublicMarketQuote, getPublicMarketSource, type MarketSourceKey } from "@/lib/market-sources";

export function normalizeSpotSymbol(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export type SpotCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

function defaultSource(sourceKey?: string | null) {
  return getPublicMarketSource(sourceKey || process.env.MARKET_DATA_PROVIDER) || getPublicMarketSource("COINBASE")!;
}

export async function marketDataIsHealthy(sourceKey?: MarketSourceKey) {
  try {
    const quote = await getPublicMarketQuote(defaultSource(sourceKey), "BTCUSD");
    return quote.live && Number.isFinite(quote.price);
  } catch {
    return false;
  }
}

export async function getSpotPrice(symbolInput: string, sourceKey?: MarketSourceKey) {
  const symbol = normalizeSpotSymbol(symbolInput);
  const quote = await getPublicMarketQuote(defaultSource(sourceKey), symbol);
  return {
    symbol,
    price: quote.price,
    provider: quote.source,
    exchange: quote.exchange,
    observedAt: new Date().toISOString(),
  };
}

export async function getSpotCandles(symbolInput: string, interval: string, limit = 120, sourceKey?: MarketSourceKey) {
  const symbol = normalizeSpotSymbol(symbolInput);
  const safeInterval = new Set(["5m", "15m", "1h", "4h", "1d"]).has(interval.toLowerCase())
    ? interval.toLowerCase()
    : "15m";
  const safeLimit = Math.min(500, Math.max(80, Math.floor(limit)));
  const result = await getPublicMarketCandles(defaultSource(sourceKey), symbol, safeInterval, safeLimit);
  const duration = ({ "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as Record<string, number>)[safeInterval] || 900_000;
  const candles = result.candles.map((candle) => ({
    openTime: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    closeTime: candle.time + duration - 1,
  } satisfies SpotCandle));
  if (candles.length < 80) throw new Error("实时策略判定所需K线少于 80 根");
  return {
    symbol,
    interval: safeInterval,
    provider: result.source,
    exchange: result.exchange,
    observedAt: new Date().toISOString(),
    candles,
  };
}
