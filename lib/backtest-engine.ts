import {
  createStrategyEvaluator,
  normalizeStrategyDsl,
  strategyDslFromBrief,
  type StrategyCandle,
  type StrategyDsl,
} from "./strategy-dsl.ts";

// Kept for the existing deterministic demo strategy runtime. New community
// strategy backtests use StrategyDsl below.
export type StrategySpecification = {
  symbol: string;
  period: string;
  style: "趋势跟随" | "区间交易" | "突破动量" | "市场中性";
  capital: number;
  stopLoss: number;
  takeProfit: number;
  maxDrawdown: number;
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

type OpenPosition = {
  entryPrice: number;
  openedAt: number;
  notional: number;
  quantity: number;
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
  parameters: StrategyDsl & {
    feeRate: number;
    slippageRate: number;
    initialEquityUsdt: number;
  };
  trades: CompletedTrade[];
};

const legacyIntervals = new Set(["5m", "15m", "1h", "4h", "1d"]);
const legacyAllowedSymbols = new Set([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT",
  "DOTUSDT", "LTCUSDT", "BCHUSDT", "TONUSDT", "SUIUSDT",
  "APTUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT",
]);

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeStrategySpecification(input: Record<string, unknown>): StrategySpecification {
  const symbol = String(input.symbol || "BTC/USDT").replace(/[^a-z0-9]/gi, "").toUpperCase();
  const interval = String(input.period || "15m").toLowerCase();
  const style = String(input.style || "趋势跟随") as StrategySpecification["style"];
  if (!legacyAllowedSymbols.has(symbol)) throw new Error("当前回测引擎仅支持平台列出的主流 USDT 交易对");
  if (!legacyIntervals.has(interval)) throw new Error("当前回测引擎仅支持 5m、15m、1h、4h 和 1D 周期");
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

function normalizeBacktestDsl(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input) && "schemaVersion" in input) {
    return normalizeStrategyDsl(input);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("策略规格格式无效");
  return strategyDslFromBrief(input as Record<string, unknown>);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function loadCandles(specification: StrategyDsl): Promise<StrategyCandle[]> {
  const base = (process.env.MARKET_DATA_BASE_URL || "https://api-gcp.binance.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(specification.symbol)}&interval=${encodeURIComponent(specification.timeframe)}&limit=1000`;
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`历史行情服务返回 ${response.status}`);
    const data = await response.json() as unknown;
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
    return candles;
  } finally {
    clearTimeout(timer);
  }
}

function validateCandles(candles: StrategyCandle[]) {
  if (candles.length < 200) throw new Error("历史K线样本不足 200 根，平台拒绝生成回测结论");
  if (candles.some((candle) => !Object.values(candle).every(Number.isFinite))) {
    throw new Error("历史K线包含无效数值");
  }
}

export async function runBacktestOnCandles(
  rawSpecification: unknown,
  candles: StrategyCandle[],
  options: {
    provider?: string;
    feeRate?: number;
    slippageRate?: number;
    initialEquityUsdt?: number;
  } = {},
): Promise<BacktestResult> {
  const specification = normalizeBacktestDsl(rawSpecification);
  validateCandles(candles);
  const evaluator = createStrategyEvaluator(specification, candles);
  const provider = options.provider || process.env.MARKET_DATA_PROVIDER || "Binance Spot REST";
  const engineVersion = "2.0.0-dsl-v1";
  const feeRate = options.feeRate ?? 0.001;
  const slippageRate = options.slippageRate ?? 0.0005;
  const initialEquityUsdt = options.initialEquityUsdt ?? 10_000;
  let equity = initialEquityUsdt;
  let peak = equity;
  let maxDrawdownPct = 0;
  let feesUsdt = 0;
  let slippageUsdt = 0;
  let consecutiveLosses = 0;
  let drawdownHalted = false;
  let consecutiveLossHalted = false;
  let currentDay = "";
  let dayStartEquity = equity;
  let dailyLossHalted = false;
  let position: OpenPosition | null = null;
  const trades: CompletedTrade[] = [];

  function currentPosition(): OpenPosition | null {
    return position;
  }

  function updateDrawdown() {
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak === 0 ? 0 : (peak - equity) / peak * 100);
    if (maxDrawdownPct >= specification.risk.maxDrawdownPct) drawdownHalted = true;
  }

  function openPosition(candle: StrategyCandle) {
    const notional = equity * specification.risk.positionPct / 100;
    const entryPrice = candle.close * (1 + slippageRate);
    const entryFee = notional * feeRate;
    feesUsdt += entryFee;
    slippageUsdt += notional * slippageRate;
    equity -= entryFee;
    position = {
      entryPrice,
      openedAt: candle.closeTime,
      notional,
      quantity: notional / entryPrice,
    };
    updateDrawdown();
  }

  function closePosition(candle: StrategyCandle, reason: string) {
    const active = currentPosition();
    if (!active) return;
    const exitPrice = candle.close * (1 - slippageRate);
    const exitValue = active.quantity * exitPrice;
    const exitFee = exitValue * feeRate;
    const gross = exitValue - active.notional;
    const netPnl = gross - exitFee;
    equity += netPnl;
    feesUsdt += exitFee;
    slippageUsdt += exitValue * slippageRate;
    trades.push({
      openedAt: active.openedAt,
      closedAt: candle.closeTime,
      entryPrice: active.entryPrice,
      exitPrice,
      netPnl,
      returnPct: netPnl / active.notional * 100,
      reason,
    });
    consecutiveLosses = netPnl < 0 ? consecutiveLosses + 1 : 0;
    if (consecutiveLosses >= specification.risk.consecutiveLossLimit) consecutiveLossHalted = true;
    position = null;
    updateDrawdown();
  }

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const day = new Date(candle.openTime).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = equity;
      dailyLossHalted = false;
    }

    let closedThisCandle = false;
    const active = currentPosition();
    if (active) {
      const changePct = (candle.close - active.entryPrice) / active.entryPrice * 100;
      if (changePct <= -specification.exit.stopLossPct) {
        closePosition(candle, "stop_loss");
        closedThisCandle = true;
      } else if (changePct >= specification.exit.takeProfitPct) {
        closePosition(candle, "take_profit");
        closedThisCandle = true;
      } else if (evaluator.exitAt(index)) {
        closePosition(candle, "dsl_exit");
        closedThisCandle = true;
      }
    }

    const dailyLossPct = dayStartEquity <= 0 ? 0 : (dayStartEquity - equity) / dayStartEquity * 100;
    if (dailyLossPct >= specification.risk.dailyLossLimitPct) dailyLossHalted = true;
    const entriesAllowed = !drawdownHalted && !consecutiveLossHalted && !dailyLossHalted;
    if (!position && !closedThisCandle && entriesAllowed && evaluator.entryAt(index)) openPosition(candle);
  }
  if (position) closePosition(candles[candles.length - 1], "period_end");

  const winners = trades.filter((trade) => trade.netPnl > 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
  const warnings: string[] = [];
  if (trades.length < 5) warnings.push("当前回测区间内交易样本少于 5 笔，统计结果仅供参考");
  if (drawdownHalted) warnings.push(`达到 ${specification.risk.maxDrawdownPct}% 最大回撤限制后已停止新开仓`);
  if (consecutiveLossHalted) warnings.push(`连续亏损达到 ${specification.risk.consecutiveLossLimit} 笔后已停止新开仓`);
  if (dailyLossHalted) warnings.push(`最后交易日触发 ${specification.risk.dailyLossLimitPct}% 单日亏损限制`);

  const immutableEvidence = {
    provider,
    engineVersion,
    specification,
    firstCandle: candles[0].openTime,
    lastCandle: candles[candles.length - 1].closeTime,
    candleCount: candles.length,
    trades,
  };
  const evidenceRef = await sha256(JSON.stringify(immutableEvidence));

  return {
    provider,
    engineVersion,
    symbol: specification.symbol,
    interval: specification.timeframe,
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

export async function runHistoricalBacktest(rawSpecification: unknown): Promise<BacktestResult> {
  const specification = normalizeBacktestDsl(rawSpecification);
  const candles = await loadCandles(specification);
  return runBacktestOnCandles(specification, candles);
}
