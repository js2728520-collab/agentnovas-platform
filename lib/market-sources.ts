import { normalizeExchange } from "@/lib/exchange-capabilities";

export type MarketSourceKey = "COINBASE" | "BINANCE" | "OKX" | "BYBIT" | "BITGET" | "GATE.IO" | "KUCOIN" | "KRAKEN";

export type MarketSource = {
  key: MarketSourceKey;
  displayName: string;
  description: string;
  baseUrl: string;
  websocketUrl?: string;
};

export type PublicMarketQuote = {
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume: number;
  open: number;
  live: boolean;
  source: string;
  exchange: MarketSourceKey;
  updatedAt: string;
};

export type PublicMarketCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export const PUBLIC_MARKET_SOURCES: MarketSource[] = [
  { key: "COINBASE", displayName: "Coinbase", description: "默认公开行情源 · USD 现货", baseUrl: "https://api.exchange.coinbase.com", websocketUrl: "wss://ws-feed.exchange.coinbase.com" },
  { key: "BINANCE", displayName: "Binance", description: "USDT 现货 · REST + WebSocket", baseUrl: "https://api.binance.com", websocketUrl: "wss://data-stream.binance.vision" },
  { key: "OKX", displayName: "OKX", description: "USDT 现货 · REST", baseUrl: "https://www.okx.com", websocketUrl: "wss://ws.okx.com:8443/ws/v5/public" },
  { key: "BYBIT", displayName: "Bybit", description: "USDT 现货 · REST + WebSocket", baseUrl: "https://api.bybit.com", websocketUrl: "wss://stream.bybit.com/v5/public/spot" },
  { key: "BITGET", displayName: "Bitget", description: "USDT 现货 · REST", baseUrl: "https://api.bitget.com", websocketUrl: "wss://ws.bitget.com/v2/ws/public" },
  { key: "GATE.IO", displayName: "Gate.io", description: "USDT 现货 · REST", baseUrl: "https://api.gateio.ws/api/v4" },
  { key: "KUCOIN", displayName: "KuCoin", description: "USDT 现货 · REST", baseUrl: "https://api.kucoin.com" },
  { key: "KRAKEN", displayName: "Kraken", description: "USD 现货 · REST", baseUrl: "https://api.kraken.com" },
];

const sourceByKey = new Map<string, MarketSource>(PUBLIC_MARKET_SOURCES.map((source) => [source.key, source]));

export function getPublicMarketSource(value: string | undefined | null) {
  return sourceByKey.get(normalizeExchange(value)) || null;
}

export function publicMarketSourcesForClient() {
  return PUBLIC_MARKET_SOURCES.map(({ key, displayName, description }) => ({ key, displayName, description }));
}

export function marketSourceLabel(source: MarketSource, base = source.baseUrl) {
  try {
    return `${source.displayName} public market data · ${new URL(base).hostname}`;
  } catch {
    return `${source.displayName} public market data`;
  }
}

function sourceBases(source: MarketSource) {
  if (source.key === "BINANCE") {
    const configured = process.env.MARKET_DATA_BASE_URL?.trim().replace(/\/$/, "");
    return [...new Set([configured, source.baseUrl, "https://data-api.binance.vision", "https://api-gcp.binance.com"].filter(Boolean))];
  }
  return [source.baseUrl];
}

export async function fetchMarketSourceJson<T>(source: MarketSource, path: string, timeoutMs = 6_000) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const failures: string[] = [];
  for (const base of sourceBases(source)) {
    try {
      const response = await fetch(`${base}${safePath}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        failures.push(`${new URL(base).hostname}: HTTP ${response.status}`);
        continue;
      }
      return { data: await response.json() as T, base };
    } catch (error) {
      failures.push(`${new URL(base).hostname}: ${error instanceof Error ? error.name : "request failed"}`);
    }
  }
  throw new Error(`${source.displayName} 公共行情源暂时不可用（${failures.join("；")}）`);
}

function numeric(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function validPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("行情源未返回有效价格");
  return value;
}

function baseAsset(symbolInput: string) {
  const symbol = String(symbolInput || "BTCUSD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol.endsWith("USD") ? symbol.slice(0, -3) : symbol;
}

function pairFor(source: MarketSource, symbolInput: string) {
  const base = baseAsset(symbolInput);
  switch (source.key) {
    case "COINBASE": return `${base}-USD`;
    case "OKX": return `${base}-USDT`;
    case "GATE.IO": return `${base}_USDT`;
    case "KUCOIN": return `${base}-USDT`;
    case "KRAKEN": return `${base === "BTC" ? "XBT" : base}USD`;
    default: return `${base}USDT`;
  }
}

function changeFields(last: number, open: number, change?: number, changePercent?: number) {
  const resolvedChange = Number.isFinite(change) && change !== undefined ? change : last - open;
  const resolvedPercent = Number.isFinite(changePercent) && changePercent !== undefined
    ? changePercent
    : open ? (resolvedChange / open) * 100 : 0;
  return { change: resolvedChange, changePercent: resolvedPercent };
}

function quoteResult(source: MarketSource, base: string, values: { price: number; open: number; high: number; low: number; volume: number; change?: number; changePercent?: number }): PublicMarketQuote {
  const price = validPrice(values.price);
  const fields = changeFields(price, values.open, values.change, values.changePercent);
  return {
    price,
    ...fields,
    high: values.high || price,
    low: values.low || price,
    volume: values.volume || 0,
    open: values.open || price,
    live: true,
    source: marketSourceLabel(source, base),
    exchange: source.key,
    updatedAt: new Date().toISOString(),
  };
}

function candleRows(rows: unknown[], mapper: (row: unknown[]) => PublicMarketCandle, before?: number) {
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error("K线行情字段不完整");
    return mapper(row);
  }).filter((row) => Object.values(row).every((value) => Number.isFinite(value) && value > 0 && (!before || row.time < before)))
    .sort((a, b) => a.time - b.time);
}

function standardCandle(row: unknown[], order: "binance" | "gate" | "kucoin") {
  if (order === "binance") return { time: numeric(row[0]), open: numeric(row[1]), high: numeric(row[2]), low: numeric(row[3]), close: numeric(row[4]), volume: numeric(row[5]) };
  if (order === "gate") return { time: numeric(row[0]) * 1000, open: numeric(row[5]), high: numeric(row[3]), low: numeric(row[4]), close: numeric(row[2]), volume: numeric(row[1]) };
  return { time: numeric(row[0]) * 1000, open: numeric(row[1]), high: numeric(row[3]), low: numeric(row[4]), close: numeric(row[2]), volume: numeric(row[5]) };
}

function intervalMinutes(interval: string) {
  return ({ "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1H": 60, "4H": 240, "1D": "D", "1W": "W" } as Record<string, number | string>)[interval] || 15;
}

function intervalSeconds(interval: string) {
  return ({ "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1H": 3600, "4H": 21600, "1D": 86400, "1W": 86400 } as Record<string, number>)[interval] || 900;
}

function intervalBitget(interval: string) {
  return ({ "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1H": "1h", "4H": "4h", "1D": "1day", "1W": "1day" } as Record<string, string>)[interval] || "15min";
}

function intervalKucoin(interval: string) {
  return ({ "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1H": "1hour", "4H": "4hour", "1D": "1day", "1W": "1week" } as Record<string, string>)[interval] || "15min";
}

export async function getPublicMarketQuote(source: MarketSource, symbolInput: string, timeoutMs = 5_000): Promise<PublicMarketQuote> {
  const pair = pairFor(source, symbolInput);
  switch (source.key) {
    case "COINBASE": {
      const [ticker, stats] = await Promise.all([
        fetchMarketSourceJson<{ price?: string }>(source, `/products/${encodeURIComponent(pair)}/ticker`, timeoutMs),
        fetchMarketSourceJson<{ open?: string; high?: string; low?: string; last?: string; volume?: string }>(source, `/products/${encodeURIComponent(pair)}/stats`, timeoutMs),
      ]);
      const price = numeric(ticker.data.price || stats.data.last);
      const open = numeric(stats.data.open) || price;
      return quoteResult(source, ticker.base, { price, open, high: numeric(stats.data.high), low: numeric(stats.data.low), volume: numeric(stats.data.volume) });
    }
    case "BINANCE": {
      const result = await fetchMarketSourceJson<{ lastPrice: string; priceChange: string; priceChangePercent: string; highPrice: string; lowPrice: string; volume: string; quoteVolume: string; openPrice: string }>(source, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`, timeoutMs);
      return quoteResult(source, result.base, { price: numeric(result.data.lastPrice), open: numeric(result.data.openPrice), high: numeric(result.data.highPrice), low: numeric(result.data.lowPrice), volume: numeric(result.data.quoteVolume || result.data.volume), change: numeric(result.data.priceChange), changePercent: numeric(result.data.priceChangePercent) });
    }
    case "OKX": {
      const result = await fetchMarketSourceJson<{ code?: string; data?: Array<Record<string, string>> }>(source, `/api/v5/market/ticker?instId=${encodeURIComponent(pair)}`, timeoutMs);
      const row = result.data.data?.[0] || {};
      return quoteResult(source, result.base, { price: numeric(row.last), open: numeric(row.open24h), high: numeric(row.high24h), low: numeric(row.low24h), volume: numeric(row.volCcy24h || row.vol24h) });
    }
    case "BYBIT": {
      const result = await fetchMarketSourceJson<{ retCode?: number; result?: { list?: Array<Record<string, string>> } }>(source, `/v5/market/tickers?category=spot&symbol=${encodeURIComponent(pair)}`, timeoutMs);
      const row = result.data.result?.list?.[0] || {};
      return quoteResult(source, result.base, { price: numeric(row.lastPrice), open: numeric(row.prevPrice24h), high: numeric(row.highPrice24h), low: numeric(row.lowPrice24h), volume: numeric(row.turnover24h || row.volume24h) });
    }
    case "BITGET": {
      const result = await fetchMarketSourceJson<{ code?: string; data?: Array<Record<string, string>> }>(source, `/api/v2/spot/market/tickers?symbol=${encodeURIComponent(pair)}`, timeoutMs);
      const row = result.data.data?.[0] || {};
      return quoteResult(source, result.base, { price: numeric(row.lastPr || row.last), open: numeric(row.open24h), high: numeric(row.high24h), low: numeric(row.low24h), volume: numeric(row.quoteVolume || row.baseVolume) });
    }
    case "GATE.IO": {
      const result = await fetchMarketSourceJson<Array<Record<string, string>>>(source, `/spot/tickers?currency_pair=${encodeURIComponent(pair)}`, timeoutMs);
      const row = result.data[0] || {};
      const price = numeric(row.last);
      const changePercent = numeric(row.change_percentage);
      const open = changePercent ? price / (1 + changePercent / 100) : price;
      return quoteResult(source, result.base, { price, open, high: numeric(row.high), low: numeric(row.low), volume: numeric(row.quote_volume), changePercent });
    }
    case "KUCOIN": {
      const result = await fetchMarketSourceJson<{ code?: string; data?: Record<string, string> }>(source, `/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(pair)}`, timeoutMs);
      const row = result.data.data || {};
      const stats = await fetchMarketSourceJson<{ code?: string; data?: Record<string, string> }>(source, `/api/v1/market/stats?symbol=${encodeURIComponent(pair)}`, timeoutMs);
      const stat = stats.data.data || {};
      const price = numeric(row.price || stat.last);
      const change = numeric(stat.changePrice);
      const open = price - change || price;
      return quoteResult(source, result.base, { price, open, high: numeric(stat.high), low: numeric(stat.low), volume: numeric(stat.volValue || stat.vol), change, changePercent: numeric(stat.changeRate) * 100 });
    }
    case "KRAKEN": {
      const result = await fetchMarketSourceJson<{ error?: string[]; result?: Record<string, { c?: string[]; o?: string; h?: string[]; l?: string[]; v?: string[] }> }>(source, `/0/public/Ticker?pair=${encodeURIComponent(pair)}`, timeoutMs);
      const row = Object.values(result.data.result || {})[0] || {};
      const price = numeric(row.c?.[0]);
      const open = numeric(row.o);
      return quoteResult(source, result.base, { price, open, high: numeric(row.h?.[1] || row.h?.[0]), low: numeric(row.l?.[1] || row.l?.[0]), volume: numeric(row.v?.[1] || row.v?.[0]) });
    }
  }
}

export async function getPublicMarketCandles(source: MarketSource, symbolInput: string, interval: string, limit = 160, before = 0, timeoutMs = 8_000) {
  const pair = pairFor(source, symbolInput);
  const intervalKey = ({ "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" } as Record<string, string>)[interval] || interval;
  const safeLimit = Math.min(500, Math.max(80, Math.floor(limit)));
  const safeBefore = before > 0 ? before : 0;
  let rows: PublicMarketCandle[];
  let base = source.baseUrl;
  switch (source.key) {
    case "COINBASE": {
      const granularity = intervalSeconds(intervalKey);
      const end = safeBefore ? safeBefore - 1 : Date.now();
      const start = end - granularity * 1000 * safeLimit;
      const result = await fetchMarketSourceJson<unknown[]>(source, `/products/${encodeURIComponent(pair)}/candles?granularity=${granularity}&start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data, (row) => ({ time: numeric(row[0]) * 1000, low: numeric(row[1]), high: numeric(row[2]), open: numeric(row[3]), close: numeric(row[4]), volume: numeric(row[5]) }), safeBefore);
      break;
    }
    case "BINANCE": {
      const end = safeBefore ? `&endTime=${encodeURIComponent(safeBefore - 1)}` : "";
      const result = await fetchMarketSourceJson<unknown[]>(source, `/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" } as Record<string, string>)[intervalKey] || "15m")}&limit=${safeLimit}${end}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data, (row) => standardCandle(row, "binance"), safeBefore);
      break;
    }
    case "OKX": {
      const result = await fetchMarketSourceJson<{ data?: unknown[][] }>(source, `/api/v5/market/candles?instId=${encodeURIComponent(pair)}&bar=${encodeURIComponent(({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W" } as Record<string, string>)[intervalKey] || "15m")}&limit=${Math.min(300, safeLimit)}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data?.data || [], (row) => ({ time: numeric(row[0]), open: numeric(row[1]), high: numeric(row[2]), low: numeric(row[3]), close: numeric(row[4]), volume: numeric(row[5]) }), safeBefore);
      break;
    }
    case "BYBIT": {
      const result = await fetchMarketSourceJson<{ result?: { list?: unknown[][] } }>(source, `/v5/market/kline?category=spot&symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(String(intervalMinutes(intervalKey)))}&limit=${Math.min(1000, safeLimit)}${safeBefore ? `&end=${encodeURIComponent(safeBefore - 1)}` : ""}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data.result?.list || [], (row) => standardCandle(row, "binance"), safeBefore);
      break;
    }
    case "BITGET": {
      const result = await fetchMarketSourceJson<{ data?: unknown[][] }>(source, `/api/v2/spot/market/candles?symbol=${encodeURIComponent(pair)}&granularity=${encodeURIComponent(intervalBitget(intervalKey))}&limit=${Math.min(1000, safeLimit)}${safeBefore ? `&endTime=${encodeURIComponent(safeBefore - 1)}` : ""}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data?.data || [], (row) => standardCandle(row, "binance"), safeBefore);
      break;
    }
    case "GATE.IO": {
      const result = await fetchMarketSourceJson<unknown[]>(source, `/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${encodeURIComponent(({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "7d" } as Record<string, string>)[intervalKey] || "15m")}&limit=${Math.min(1000, safeLimit)}${safeBefore ? `&to=${encodeURIComponent(Math.floor(safeBefore / 1000) - 1)}` : ""}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data, (row) => standardCandle(row, "gate"), safeBefore);
      break;
    }
    case "KUCOIN": {
      const end = safeBefore ? Math.floor(safeBefore / 1000) - 1 : Math.floor(Date.now() / 1000);
      const start = end - intervalSeconds(intervalKey) * safeLimit;
      const result = await fetchMarketSourceJson<{ code?: string; data?: unknown[][] }>(source, `/api/v1/market/candles?symbol=${encodeURIComponent(pair)}&type=${encodeURIComponent(intervalKucoin(intervalKey))}&startAt=${start}&endAt=${end}`, timeoutMs);
      base = result.base;
      rows = candleRows(result.data?.data || [], (row) => standardCandle(row, "kucoin"), safeBefore);
      break;
    }
    case "KRAKEN": {
      const result = await fetchMarketSourceJson<{ result?: Record<string, unknown[][]> }>(source, `/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${Math.max(1, Math.round(intervalSeconds(intervalKey) / 60))}`, timeoutMs);
      base = result.base;
      const data = Object.values(result.data.result || {}).find(Array.isArray) || [];
      rows = candleRows(data, (row) => ({ time: numeric(row[0]) * 1000, open: numeric(row[1]), high: numeric(row[2]), low: numeric(row[3]), close: numeric(row[4]), volume: numeric(row[6]) }), safeBefore);
      break;
    }
  }
  return { candles: rows.slice(-safeLimit), source: marketSourceLabel(source, base), exchange: source.key, updatedAt: new Date().toISOString() };
}
