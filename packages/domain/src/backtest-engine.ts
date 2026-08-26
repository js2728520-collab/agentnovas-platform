// 回测引擎（纯计算部分）。
//
// 行情加载与编排留在 lib/backtest-engine.ts —— 那部分要发真实 HTTP 请求，
// 属于适配器层。本文件只接收已经取到的 K 线，因此可以毫秒级单测，
// 也能被 Worker 直接使用而不必 import Next。
//
// 见 packages/domain/CLAUDE.md：域层不做 I/O，需要外部数据时由调用方传入。

import {
  createStrategyLegEvaluator,
  createStrategyEvaluator,
  normalizeResearchStrategyDsl,
  normalizeStrategyDsl,
  strategyDslToRuntime,
  strategyDslFromBrief,
  type ResearchStrategyDsl,
  type StrategyCandle,
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
  side?: "long" | "short";
  grossPnl?: number;
  feesUsdt?: number;
  fundingUsdt?: number;
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
  fundingUsdt: number;
  slippageUsdt: number;
  liquidated: boolean;
  finalEquityUsdt: number;
  warnings: string[];
  evidenceRef: string;
  parameters: ResearchStrategyDsl & {
    feeRate: number;
    slippageRate: number;
    initialEquityUsdt: number;
    preset: BacktestPreset;
    candleLimit: number;
  };
  trades: CompletedTrade[];
};

export type HistoricalFundingRate = {
  time: number;
  rate: number;
};

export type PerpetualBacktestOptionsInput = BacktestOptionsInput & {
  maintenanceMarginRate?: number;
};

export type BacktestPreset = "live_aligned" | "exploration";

export type BacktestOptions = {
  preset: BacktestPreset;
  feeRate: number;
  slippageRate: number;
  initialEquityUsdt: number;
  candleLimit: number;
};

export type BacktestOptionsInput = Partial<BacktestOptions> & { provider?: string };

function boundedBacktestNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  integer = false,
) {
  if (value !== undefined && typeof value !== "number") throw new Error(`${label}必须是数字`);
  const number = value === undefined ? fallback : value;
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error(`${label}必须在 ${minimum}–${maximum}${integer ? " 的整数" : ""}范围内`);
  }
  return number;
}

function normalizeBacktestOptionsWithCandleMaximum(
  input: BacktestOptionsInput,
  maximumCandleLimit: number,
): BacktestOptions {
  const preset = input.preset ?? "live_aligned";
  if (preset !== "live_aligned" && preset !== "exploration") throw new Error("不支持的回测预设");
  return {
    preset,
    feeRate: boundedBacktestNumber(input.feeRate, 0.001, 0, 0.01, "手续费率"),
    slippageRate: boundedBacktestNumber(
      input.slippageRate,
      preset === "live_aligned" ? 0.0005 : 0,
      0,
      0.02,
      "滑点率",
    ),
    initialEquityUsdt: boundedBacktestNumber(input.initialEquityUsdt, 10_000, 100, 1_000_000, "初始资金"),
    candleLimit: boundedBacktestNumber(input.candleLimit, 1_000, 200, maximumCandleLimit, "K线数量", true),
  };
}

export function normalizeBacktestOptions(input: BacktestOptionsInput = {}): BacktestOptions {
  return normalizeBacktestOptionsWithCandleMaximum(input, 1_000);
}

export function normalizePerpetualBacktestOptions(input: BacktestOptionsInput = {}): BacktestOptions {
  return normalizeBacktestOptionsWithCandleMaximum(input, 30_000);
}

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

export function normalizeBacktestDsl(input: unknown) {
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


function validateCandles(candles: StrategyCandle[]) {
  if (candles.length < 200) throw new Error("历史K线样本不足 200 根，平台拒绝生成回测结论");
  if (candles.some((candle) => !Object.values(candle).every(Number.isFinite))) {
    throw new Error("历史K线包含无效数值");
  }
}

export async function runBacktestOnCandles(
  rawSpecification: unknown,
  candles: StrategyCandle[],
  options: BacktestOptionsInput = {},
): Promise<BacktestResult> {
  const specification = normalizeBacktestDsl(rawSpecification);
  validateCandles(candles);
  const normalizedOptions = normalizeBacktestOptions(options);
  const evaluator = createStrategyEvaluator(specification, candles);
  const provider = options.provider || process.env.MARKET_DATA_PROVIDER || "Binance Spot REST";
  const engineVersion = "2.0.0-dsl-v1";
  const { feeRate, slippageRate, initialEquityUsdt } = normalizedOptions;
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
    backtestOptions: normalizedOptions,
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
    fundingUsdt: 0,
    slippageUsdt: Number(slippageUsdt.toFixed(4)),
    liquidated: false,
    finalEquityUsdt: Number(equity.toFixed(4)),
    warnings,
    evidenceRef,
    parameters: { ...specification, ...normalizedOptions },
    trades,
  };
}

type PerpetualSide = "long" | "short";

type PerpetualPosition = {
  side: PerpetualSide;
  entryPrice: number;
  openedAt: number;
  notional: number;
  quantity: number;
  entryFee: number;
  fundingUsdt: number;
};

function normalizeFundingRates(input: HistoricalFundingRate[]) {
  const byTime = new Map<number, HistoricalFundingRate>();
  for (const item of input) {
    if (!Number.isFinite(item.time) || !Number.isFinite(item.rate) || Math.abs(item.rate) > 0.1) {
      throw new Error("历史资金费率包含无效数值");
    }
    byTime.set(item.time, { time: item.time, rate: item.rate });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function validatePerpetualCandles(candles: StrategyCandle[]) {
  validateCandles(candles);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      throw new Error("历史K线价格必须大于 0");
    }
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      throw new Error("历史K线高低价关系无效");
    }
    if (index > 0 && candle.openTime <= candles[index - 1].openTime) {
      throw new Error("历史K线时间必须严格递增且不能重复");
    }
  }
}

export async function runPerpetualBacktestOnCandles(
  rawSpecification: unknown,
  candles: StrategyCandle[],
  rawFundingRates: HistoricalFundingRate[],
  rawOptions: PerpetualBacktestOptionsInput = {},
): Promise<BacktestResult> {
  const storedSpecification = normalizeResearchStrategyDsl(rawSpecification);
  const specification = strategyDslToRuntime(storedSpecification);
  validatePerpetualCandles(candles);
  const fundingRates = normalizeFundingRates(rawFundingRates);
  const options = normalizePerpetualBacktestOptions(rawOptions);
  const maintenanceMarginRate = boundedBacktestNumber(
    rawOptions.maintenanceMarginRate,
    0.005,
    0.001,
    0.05,
    "维持保证金率",
  );
  const provider = rawOptions.provider || process.env.MARKET_DATA_PROVIDER || "Perpetual market adapter";
  const engineVersion = "4.0.0-dsl-v3-unified";
  const evaluators = {
    long: specification.legs.long ? createStrategyLegEvaluator(specification.legs.long, candles) : null,
    short: specification.legs.short ? createStrategyLegEvaluator(specification.legs.short, candles) : null,
  };

  let equity = options.initialEquityUsdt;
  let peak = equity;
  let maxDrawdownPct = 0;
  let feesUsdt = 0;
  let fundingUsdt = 0;
  let slippageUsdt = 0;
  let position: PerpetualPosition | null = null;
  let pendingEntry: PerpetualSide | null = null;
  let pendingExit = false;
  let consecutiveLosses = 0;
  let drawdownHalted = false;
  let consecutiveLossHalted = false;
  let dailyLossHalted = false;
  let currentDay = "";
  let dayStartEquity = equity;
  let liquidated = false;
  let conflictingSignals = 0;
  let fundingIndex = 0;
  const trades: CompletedTrade[] = [];

  function activePosition() {
    return position;
  }

  function updateDrawdown() {
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
    if (maxDrawdownPct >= specification.risk.maxDrawdownPct) drawdownHalted = true;
  }

  function openPosition(side: PerpetualSide, candle: StrategyCandle) {
    const notional = equity * specification.risk.positionSizePct / 100;
    const entryPrice = candle.open * (side === "long" ? 1 + options.slippageRate : 1 - options.slippageRate);
    const entryFee = notional * options.feeRate;
    feesUsdt += entryFee;
    slippageUsdt += Math.abs(entryPrice - candle.open) * (notional / entryPrice);
    equity -= entryFee;
    position = {
      side,
      entryPrice,
      openedAt: candle.openTime,
      notional,
      quantity: notional / entryPrice,
      entryFee,
      fundingUsdt: 0,
    };
    updateDrawdown();
  }

  function closePosition(rawPrice: number, closedAt: number, reason: string, capAtIsolatedMargin = false) {
    const active = activePosition();
    if (!active) return;
    const exitPrice = rawPrice * (active.side === "long" ? 1 - options.slippageRate : 1 + options.slippageRate);
    const exitValue = active.quantity * exitPrice;
    const exitFee = exitValue * options.feeRate;
    const grossPnl = active.side === "long"
      ? active.quantity * (exitPrice - active.entryPrice)
      : active.quantity * (active.entryPrice - exitPrice);
    const uncappedRealized = grossPnl - exitFee;
    const realized = capAtIsolatedMargin
      ? Math.max(uncappedRealized, -active.notional * (1 - maintenanceMarginRate))
      : uncappedRealized;
    const netPnl = realized - active.entryFee + active.fundingUsdt;
    equity += realized;
    feesUsdt += exitFee;
    slippageUsdt += Math.abs(exitPrice - rawPrice) * active.quantity;
    trades.push({
      openedAt: active.openedAt,
      closedAt,
      entryPrice: active.entryPrice,
      exitPrice,
      netPnl,
      returnPct: active.notional ? netPnl / active.notional * 100 : 0,
      reason,
      side: active.side,
      grossPnl,
      feesUsdt: active.entryFee + exitFee,
      fundingUsdt: active.fundingUsdt,
    });
    consecutiveLosses = netPnl < 0 ? consecutiveLosses + 1 : 0;
    if (consecutiveLosses >= specification.risk.maxConsecutiveLosses) consecutiveLossHalted = true;
    position = null;
    pendingExit = false;
    updateDrawdown();
  }

  function applyFunding(candle: StrategyCandle) {
    while (fundingIndex < fundingRates.length && fundingRates[fundingIndex].time <= candle.closeTime) {
      const funding = fundingRates[fundingIndex];
      const active = activePosition();
      if (active && active.openedAt < funding.time && funding.time >= candle.openTime) {
        const cashFlow = active.notional * funding.rate * (active.side === "short" ? 1 : -1);
        active.fundingUsdt += cashFlow;
        fundingUsdt += cashFlow;
        equity += cashFlow;
        updateDrawdown();
      }
      fundingIndex += 1;
    }
  }

  function riskExit(candle: StrategyCandle) {
    const active = activePosition();
    if (!active) return false;
    const leg = active.side === "long" ? specification.legs.long! : specification.legs.short!;
    const liquidationPrice = active.side === "long"
      ? active.entryPrice * maintenanceMarginRate
      : active.entryPrice * (2 - maintenanceMarginRate);
    const gapLiquidation = active.side === "long"
      ? candle.open <= liquidationPrice
      : candle.open >= liquidationPrice;
    if (gapLiquidation) {
      closePosition(candle.open, candle.openTime, "liquidation", true);
      liquidated = true;
      return true;
    }

    const stopPrice = active.side === "long"
      ? active.entryPrice * (1 - leg.stopLossPct / 100)
      : active.entryPrice * (1 + leg.stopLossPct / 100);
    const takePrice = active.side === "long"
      ? active.entryPrice * (1 + leg.takeProfitPct / 100)
      : active.entryPrice * (1 - leg.takeProfitPct / 100);
    const stopTouched = active.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
    const takeTouched = active.side === "long" ? candle.high >= takePrice : candle.low <= takePrice;
    if (stopTouched) {
      closePosition(stopPrice, candle.closeTime, "stop_loss");
      return true;
    }
    if (takeTouched) {
      closePosition(takePrice, candle.closeTime, "take_profit");
      return true;
    }
    const intrabarLiquidation = active.side === "long"
      ? candle.low <= liquidationPrice
      : candle.high >= liquidationPrice;
    if (intrabarLiquidation) {
      closePosition(liquidationPrice, candle.closeTime, "liquidation", true);
      liquidated = true;
      return true;
    }
    return false;
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
    if (position && pendingExit) {
      closePosition(candle.open, candle.openTime, "dsl_exit");
      closedThisCandle = true;
    }
    const entriesAllowed = !drawdownHalted && !consecutiveLossHalted && !dailyLossHalted && !liquidated;
    if (!position && !closedThisCandle && pendingEntry && entriesAllowed) {
      openPosition(pendingEntry, candle);
    }
    pendingEntry = null;

    applyFunding(candle);
    if (position && riskExit(candle)) closedThisCandle = true;

    const dailyLossPct = dayStartEquity > 0 ? (dayStartEquity - equity) / dayStartEquity * 100 : 0;
    if (dailyLossPct >= specification.risk.maxDailyLossPct) dailyLossHalted = true;

    const active = activePosition();
    if (active) {
      const evaluator = active.side === "long" ? evaluators.long : evaluators.short;
      if (evaluator?.exitAt(index)) pendingExit = true;
    } else if (!closedThisCandle && !drawdownHalted && !consecutiveLossHalted && !dailyLossHalted && !liquidated) {
      const longSignal = Boolean(evaluators.long?.entryAt(index));
      const shortSignal = Boolean(evaluators.short?.entryAt(index));
      if (longSignal && shortSignal) conflictingSignals += 1;
      else if (longSignal) pendingEntry = "long";
      else if (shortSignal) pendingEntry = "short";
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    closePosition(last.close, last.closeTime, "period_end");
  }

  const winners = trades.filter((trade) => trade.netPnl > 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
  const warnings: string[] = [];
  if (trades.length < 20) warnings.push("样本外完成交易少于 20 笔，不能通过标准验证");
  if (drawdownHalted) warnings.push(`达到 ${specification.risk.maxDrawdownPct}% 最大回撤限制后已停止新开仓`);
  if (consecutiveLossHalted) warnings.push(`连续亏损达到 ${specification.risk.maxConsecutiveLosses} 笔后已停止新开仓`);
  if (dailyLossHalted) warnings.push(`最后交易日触发 ${specification.risk.maxDailyLossPct}% 单日亏损限制`);
  if (liquidated) warnings.push("回测发生模拟爆仓，候选不能通过验证");
  if (conflictingSignals) warnings.push(`${conflictingSignals} 根 K 线同时触发多空信号，平台按无交易处理`);

  const evidenceRef = await sha256(JSON.stringify({
    provider,
    engineVersion,
    specification: storedSpecification,
    runtimeSpecification: specification,
    maintenanceMarginRate,
    firstCandle: candles[0].openTime,
    lastCandle: candles[candles.length - 1].closeTime,
    candleCount: candles.length,
    fundingRates,
    backtestOptions: options,
    trades,
  }));

  return {
    provider,
    engineVersion,
    symbol: specification.symbol,
    interval: specification.timeframe,
    periodStart: new Date(candles[0].openTime).toISOString(),
    periodEnd: new Date(candles[candles.length - 1].closeTime).toISOString(),
    candleCount: candles.length,
    sampleSize: trades.length,
    netReturnPct: Number(((equity - options.initialEquityUsdt) / options.initialEquityUsdt * 100).toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    winRatePct: Number((trades.length ? winners.length / trades.length * 100 : 0).toFixed(4)),
    profitFactor: Number((grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0).toFixed(4)),
    feesUsdt: Number(feesUsdt.toFixed(4)),
    fundingUsdt: Number(fundingUsdt.toFixed(4)),
    slippageUsdt: Number(slippageUsdt.toFixed(4)),
    liquidated,
    finalEquityUsdt: Number(equity.toFixed(4)),
    warnings,
    evidenceRef,
    parameters: { ...storedSpecification, ...options },
    trades,
  };
}

// 转出回测调用方需要的 DSL 类型，避免它们为了一个类型再引一次 strategy-dsl。
export type { StrategyCandle, StrategyDsl } from "./strategy-dsl.ts";
