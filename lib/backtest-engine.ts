import { getPublicMarketCandles, getPublicMarketSource } from "@/lib/market-sources";

export type StrategySpecification = {
  symbol: string;
  period: string;
  style: "趋势跟随" | "区间交易" | "突破动量" | "市场中性";
  capital: number;
  stopLoss: number;
  takeProfit: number;
  maxDrawdown: number;
};

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

type CompletedTrade = {
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  returnPct: number;
  reason: string;
};

export type BacktestResult = {
  provider: string;
  engineVersion: string;
  symbol: string;
  interval: string;
  periodStart: string;
  periodEnd: string;
  candleCount: number;
  sampleSize: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  feesUsdt: number;
  slippageUsdt: number;
  finalEquityUsdt: number;
  warnings: string[];
  evidenceRef: string;
  parameters: StrategySpecification & { feeRate: number; slippageRate: number; initialEquityUsdt: number };
  trades: CompletedTrade[];
};

const intervals = new Set(["5m", "15m", "1h", "4h", "1d"]);
const allowedSymbols = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "TONUSDT", "SUIUSDT", "APTUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT"]);

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeStrategySpecification(input: Record<string, unknown>): StrategySpecification {
  const symbol = String(input.symbol || "BTC/USDT").replace(/[^a-z0-9]/gi, "").toUpperCase();
  const interval = String(input.period || "15m").toLowerCase();
  const style = String(input.style || "趋势跟随") as StrategySpecification["style"];
  if (!allowedSymbols.has(symbol)) throw new Error("当前回测引擎仅支持平台列出的主流 USDT 交易对");
  if (!intervals.has(interval)) throw new Error("当前回测引擎仅支持 5m、15m、1h、4h 和 1D 周期");
  if (!["趋势跟随", "区间交易", "突破动量", "市场中性"].includes(style)) throw new Error("不支持的策略类型");
  if (style === "市场中性") throw new Error("市场中性策略需要多资产相关性和对冲引擎，首期真实回测暂不开放，不能使用模拟结果代替");
  return {
    symbol,
    period: interval,
    style,
    capital: Math.min(30, Math.max(1, finiteNumber(input.capital, 5))),
    stopLoss: Math.min(20, Math.max(0.5, finiteNumber(input.stopLoss, 2))),
    takeProfit: Math.min(30, Math.max(0.5, finiteNumber(input.takeProfit, 4))),
    maxDrawdown: Math.min(50, Math.max(1, finiteNumber(input.maxDrawdown, 12))),
  };
}

function ema(values: number[], period: number) {
  const result = Array(values.length).fill(Number.NaN) as number[];
  if (values.length < period) return result;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
    result[i] = current;
  }
  return result;
}

function rsi(values: number[], period = 14) {
  const result = Array(values.length).fill(Number.NaN) as number[];
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    result[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

function highest(candles: Candle[], endExclusive: number, length: number) {
  return Math.max(...candles.slice(Math.max(0, endExclusive - length), endExclusive).map((candle) => candle.high));
}

function lowest(candles: Candle[], endExclusive: number, length: number) {
  return Math.min(...candles.slice(Math.max(0, endExclusive - length), endExclusive).map((candle) => candle.low));
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function loadCandles(specification: StrategySpecification): Promise<Candle[]> {
  const source = getPublicMarketSource(process.env.MARKET_DATA_PROVIDER) || getPublicMarketSource("COINBASE")!;
  const result = await getPublicMarketCandles(source, specification.symbol, specification.period, 500);
  const duration = ({ "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as Record<string, number>)[specification.period] || 900_000;
  const candles = result.candles.map((candle) => ({ ...candle, openTime: candle.time, closeTime: candle.time + duration - 1 }));
  if (candles.length < 200) throw new Error("历史K线样本不足 200 根，平台拒绝生成回测结论");
  return candles;
}

export async function runHistoricalBacktest(rawSpecification: Record<string, unknown>): Promise<BacktestResult> {
  const specification = normalizeStrategySpecification(rawSpecification);
  const candles = await loadCandles(specification);
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const fast = ema(closes, 20);
  const slow = ema(closes, 60);
  const volumeAverage = ema(volumes, 20);
  const relativeStrength = rsi(closes, 14);
  const feeRate = 0.001;
  const slippageRate = 0.0005;
  const initialEquityUsdt = 10_000;
  let equity = initialEquityUsdt;
  let peak = equity;
  let maxDrawdownPct = 0;
  let feesUsdt = 0;
  let slippageUsdt = 0;
  let position: null | { entryPrice: number; openedAt: number; notional: number; quantity: number } = null;
  const trades: CompletedTrade[] = [];

  const openPosition = (candle: Candle) => {
    const notional = equity * specification.capital / 100;
    const entryPrice = candle.close * (1 + slippageRate);
    const entryFee = notional * feeRate;
    feesUsdt += entryFee;
    slippageUsdt += notional * slippageRate;
    equity -= entryFee;
    position = { entryPrice, openedAt: candle.closeTime, notional, quantity: notional / entryPrice };
  };

  const closePosition = (candle: Candle, reason: string) => {
    if (!position) return;
    const exitPrice = candle.close * (1 - slippageRate);
    const exitValue = position.quantity * exitPrice;
    const exitFee = exitValue * feeRate;
    const gross = exitValue - position.notional;
    const netPnl = gross - exitFee;
    equity += netPnl;
    feesUsdt += exitFee;
    slippageUsdt += exitValue * slippageRate;
    trades.push({ openedAt: position.openedAt, closedAt: candle.closeTime, entryPrice: position.entryPrice, exitPrice, netPnl, returnPct: netPnl / position.notional * 100, reason });
    position = null;
  };

  for (let index = 60; index < candles.length; index += 1) {
    const candle = candles[index];
    if (position) {
      const changePct = (candle.close - position.entryPrice) / position.entryPrice * 100;
      if (changePct <= -specification.stopLoss) closePosition(candle, "stop_loss");
      else if (changePct >= specification.takeProfit) closePosition(candle, "take_profit");
      else if (specification.style === "趋势跟随" && fast[index] < slow[index]) closePosition(candle, "trend_exit");
      else if (specification.style === "区间交易" && relativeStrength[index] >= 60) closePosition(candle, "rsi_exit");
      else if (specification.style === "突破动量" && candle.close < lowest(candles, index, 10)) closePosition(candle, "channel_exit");
    }
    if (!position) {
      const volumeConfirmed = candle.volume >= volumeAverage[index] * 0.85;
      if (specification.style === "趋势跟随" && fast[index] > slow[index] && fast[index - 1] <= slow[index - 1] && volumeConfirmed) openPosition(candle);
      else if (specification.style === "区间交易" && relativeStrength[index] <= 30 && candle.close > candle.open) openPosition(candle);
      else if (specification.style === "突破动量" && candle.close > highest(candles, index, 20) && volumeConfirmed) openPosition(candle);
    }
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak === 0 ? 0 : (peak - equity) / peak * 100);
  }
  if (position) closePosition(candles[candles.length - 1], "period_end");

  const winners = trades.filter((trade) => trade.netPnl > 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
  const warnings: string[] = [];
  if (trades.length < 5) warnings.push("当前回测区间内交易样本少于 5 笔，统计结果仅供参考");
  if (maxDrawdownPct > specification.maxDrawdown) warnings.push(`回测最大回撤高于策略设置的 ${specification.maxDrawdown}%`);
  const immutableEvidence = { provider: process.env.MARKET_DATA_PROVIDER || "Coinbase public market data", engineVersion: "1.0.0", specification, firstCandle: candles[0].openTime, lastCandle: candles[candles.length - 1].closeTime, candleCount: candles.length, trades };
  const evidenceRef = await sha256(JSON.stringify(immutableEvidence));
  return {
    provider: immutableEvidence.provider,
    engineVersion: immutableEvidence.engineVersion,
    symbol: specification.symbol,
    interval: specification.period,
    periodStart: new Date(candles[0].openTime).toISOString(),
    periodEnd: new Date(candles[candles.length - 1].closeTime).toISOString(),
    candleCount: candles.length,
    sampleSize: trades.length,
    netReturnPct: Number(((equity - initialEquityUsdt) / initialEquityUsdt * 100).toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    winRatePct: Number((trades.length ? winners.length / trades.length * 100 : 0).toFixed(4)),
    profitFactor: Number((grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0).toFixed(4)),
    feesUsdt: Number(feesUsdt.toFixed(4)),
    slippageUsdt: Number(slippageUsdt.toFixed(4)),
    finalEquityUsdt: Number(equity.toFixed(4)),
    warnings,
    evidenceRef,
    parameters: { ...specification, feeRate, slippageRate, initialEquityUsdt },
    trades,
  };
}
