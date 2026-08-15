const DEFAULT_MARKET_DATA_BASE_URL = "https://api-gcp.binance.com";

function baseUrl() {
  return (process.env.MARKET_DATA_BASE_URL || DEFAULT_MARKET_DATA_BASE_URL).replace(/\/$/, "");
}

async function marketFetch(path: string, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

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

export async function marketDataIsHealthy() {
  try {
    const response = await marketFetch("/api/v3/time", 2_500);
    if (!response.ok) return false;
    const payload = await response.json() as { serverTime?: number };
    return Number.isFinite(payload.serverTime);
  } catch {
    return false;
  }
}

export async function getSpotPrice(symbolInput: string) {
  const symbol = normalizeSpotSymbol(symbolInput);
  const response = await marketFetch(`/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new Error(`行情源返回 ${response.status}`);
  const payload = await response.json() as { price?: string };
  const price = Number(payload.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("行情源未返回有效价格");
  return {
    symbol,
    price,
    provider: process.env.MARKET_DATA_PROVIDER || "binance-compatible",
    observedAt: new Date().toISOString(),
  };
}

export async function getSpotCandles(symbolInput: string, interval: string, limit = 120) {
  const symbol = normalizeSpotSymbol(symbolInput);
  const safeInterval = new Set(["5m", "15m", "1h", "4h", "1d"]).has(interval.toLowerCase())
    ? interval.toLowerCase()
    : "15m";
  const safeLimit = Math.min(500, Math.max(80, Math.floor(limit)));
  const response = await marketFetch(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(safeInterval)}&limit=${safeLimit}`, 8_000);
  if (!response.ok) throw new Error(`历史行情源返回 ${response.status}`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error("K线行情格式无效");
  const candles = payload.map((row) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error("K线行情字段不完整");
    return {
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    } satisfies SpotCandle;
  }).filter((candle) => Object.values(candle).every(Number.isFinite));
  if (candles.length < 80) throw new Error("实时策略判定所需K线少于 80 根");
  return {
    symbol,
    interval: safeInterval,
    provider: process.env.MARKET_DATA_PROVIDER || "binance-compatible",
    observedAt: new Date().toISOString(),
    candles,
  };
}
