export type ResearchCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketResearchSnapshot = {
  symbol: string;
  timeframe: "1h";
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  ema20: number;
  ema60: number;
  rsi14: number;
  atr14: number;
  support: number;
  resistance: number;
  candleCount: number;
  latestCandleAt: string;
  source: string;
};

function round(value: number, digits = 8) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce(
    (previous, value) => value * multiplier + previous * (1 - multiplier),
    values[0],
  );
}

function rsi(values: number[], period = 14) {
  const recent = values.slice(-period - 1);
  const changes = recent.slice(1).map((value, index) => value - recent[index]);
  const gains = changes.reduce((total, value) => total + Math.max(value, 0), 0) / period;
  const losses = changes.reduce((total, value) => total + Math.max(-value, 0), 0) / period;
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(candles: ResearchCandle[], period = 14) {
  const recent = candles.slice(-period - 1);
  const trueRanges = recent.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - recent[index].close),
    Math.abs(candle.low - recent[index].close),
  ));
  return trueRanges.reduce((total, value) => total + value, 0) / trueRanges.length;
}

export function summarizeResearchCandles(
  symbol: string,
  candles: ResearchCandle[],
  source: string,
): MarketResearchSnapshot {
  if (candles.length < 60) throw new Error("至少需要 60 根有效 K 线生成研究快照");
  if (!candles.every((candle) => (
    Number.isFinite(candle.openTime)
    && Number.isFinite(candle.closeTime)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    && candle.high >= candle.low
  ))) throw new Error("K 线数据无效");

  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1)!;
  const previous24h = candles[Math.max(0, candles.length - 25)].close;
  const recent24h = candles.slice(-24);
  const localRange = candles.slice(-20);

  return {
    symbol,
    timeframe: "1h",
    price: round(latest.close),
    change24hPct: round(((latest.close - previous24h) / previous24h) * 100, 2),
    high24h: round(Math.max(...recent24h.map((candle) => candle.high))),
    low24h: round(Math.min(...recent24h.map((candle) => candle.low))),
    ema20: round(ema(closes, 20)),
    ema60: round(ema(closes, 60)),
    rsi14: round(rsi(closes), 2),
    atr14: round(atr(candles)),
    support: round(Math.min(...localRange.map((candle) => candle.low))),
    resistance: round(Math.max(...localRange.map((candle) => candle.high))),
    candleCount: candles.length,
    latestCandleAt: new Date(latest.closeTime).toISOString(),
    source,
  };
}
