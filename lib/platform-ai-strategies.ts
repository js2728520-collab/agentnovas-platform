import type { SpotCandle } from "@/lib/market-data";
import {
  officialTradingHallStrategies,
  type OfficialTradingHallStrategy,
} from "@/packages/contracts/src/trading-hall";

export type PlatformStrategyCode = OfficialTradingHallStrategy["code"];
export type PlatformStrategyAction = "enter" | "exit" | "hold";

export type PlatformStrategyDefinition = OfficialTradingHallStrategy & {
  product: "spot_usdt";
  publicId: "ai-stable" | "ai-balanced" | "ai-aggressive";
  version: string;
  riskLevel: "low" | "medium" | "high";
  interval: "5m" | "15m" | "1h";
  minimumConfidence: number;
};

export type PlatformAgentMessage = { agent: string; message: string };

export type PlatformStrategySignal = {
  action: PlatformStrategyAction;
  confidence: number;
  reason: string;
  metrics: {
    lastPrice: number;
    ema9: number;
    ema21: number;
    ema55: number;
    rsi14: number;
    atrPct: number;
    volumeRatio: number;
    momentum6Pct: number;
    channelHigh20: number;
    channelLow10: number;
    bollingerUpper: number;
    bollingerLower: number;
    candleCloseTime: string;
  };
  riskReview: {
    approved: boolean;
    risk: OfficialTradingHallStrategy["risk"];
    leverageEnabled: false;
    shortSellingEnabled: false;
    fundingEnabled: false;
    objections: string[];
  };
  agentMessages: PlatformAgentMessage[];
};

const runtimeMetadata = {
  ai_conservative: { publicId: "ai-stable", version: "v3.2.0", riskLevel: "low", minimumConfidence: 72 },
  ai_balanced: { publicId: "ai-balanced", version: "v4.2.0", riskLevel: "medium", minimumConfidence: 68 },
  ai_aggressive: { publicId: "ai-aggressive", version: "v2.2.0", riskLevel: "high", minimumConfidence: 75 },
} as const;

export const PLATFORM_AI_STRATEGIES = Object.fromEntries(officialTradingHallStrategies.map((official) => [
  official.code,
  {
    ...official,
    ...runtimeMetadata[official.code],
    product: official.targetMarket,
    symbols: [...official.symbols],
    risk: { ...official.risk },
    interval: official.decisionTimeframes.at(-1)!,
  },
])) as unknown as Record<PlatformStrategyCode, PlatformStrategyDefinition>;

export function platformStrategyCodeFromPublicId(value: string): PlatformStrategyCode | null {
  const definition = Object.values(PLATFORM_AI_STRATEGIES).find((item) => item.publicId === value || item.code === value);
  return definition?.code ?? null;
}

export function isPlatformStrategyCode(value: string): value is PlatformStrategyCode {
  return value in PLATFORM_AI_STRATEGIES;
}

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function ema(values: number[], period: number) {
  const result = Array(values.length).fill(Number.NaN) as number[];
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function rsi(values: number[], period = 14) {
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / Math.max(losses, Number.EPSILON);
  return 100 - 100 / (1 + relativeStrength);
}

function atr(candles: SpotCandle[], period = 14) {
  const values = candles.slice(-period).map((candle, index, rows) => {
    const previousClose = index ? rows[index - 1].close : candle.open;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function signalMessages(
  definition: PlatformStrategyDefinition,
  symbol: string,
  action: PlatformStrategyAction,
  confidence: number,
  reason: string,
  metrics: PlatformStrategySignal["metrics"],
  objections: string[],
) {
  const direction = action === "enter" ? "候选入场" : action === "exit" ? "退出仓位" : "继续观察";
  const riskText = objections.length ? objections.join("；") : "未发现突破硬风控边界的项目";
  return [
    { agent: "市场分析师", message: `${symbol} 最新完整K线已同步，现价 ${metrics.lastPrice}，ATR 波动 ${metrics.atrPct}%。` },
    { agent: "技术分析师", message: `EMA9/21/55 为 ${metrics.ema9}/${metrics.ema21}/${metrics.ema55}，RSI14 为 ${metrics.rsi14}。` },
    { agent: "策略研究员", message: `${definition.name} 形成“${direction}”意见，模型置信度 ${confidence}%。` },
    { agent: "反方审查员", message: objections.length ? `反方异议：${riskText}` : `已检查量价背离、追高和波动扩张，暂未提出否决。` },
    { agent: "首席风控官", message: `单资产上限 ${definition.risk.maxAssetAllocationPct}%，组合上限 ${definition.risk.maxTotalAllocationPct}%，不启用杠杆。` },
    { agent: "交易执行员", message: action === "hold" ? "当前没有可执行指令，订单通道保持待命。" : `${direction}指令必须通过账户权限、会员状态和总仓位检查后才能提交。` },
    { agent: "审计 Agent", message: `${reason}；本轮行情时间与指标证据已写入决策记录。` },
  ];
}

export function evaluatePlatformStrategy(
  definition: PlatformStrategyDefinition,
  symbol: string,
  candles: SpotCandle[],
  hasOpenPosition: boolean,
): PlatformStrategySignal {
  if (candles.length < 90) throw new Error("平台 AI 策略至少需要 90 根完整K线");
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const fast = ema(closes, 9);
  const medium = ema(closes, 21);
  const slow = ema(closes, 55);
  const volumeAverage = ema(volumes, 20);
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const last20 = closes.slice(-20);
  const average20 = last20.reduce((sum, value) => sum + value, 0) / last20.length;
  const deviation20 = standardDeviation(last20);
  const channelHigh20 = Math.max(...candles.slice(-21, -1).map((candle) => candle.high));
  const channelLow10 = Math.min(...candles.slice(-11, -1).map((candle) => candle.low));
  const volumeRatio = volumeAverage[lastIndex] > 0 ? last.volume / volumeAverage[lastIndex] : 0;
  const strength = rsi(closes);
  const momentum6Pct = (last.close / closes[lastIndex - 6] - 1) * 100;
  const atrPct = atr(candles) / last.close * 100;
  const metrics: PlatformStrategySignal["metrics"] = {
    lastPrice: round(last.close, 8),
    ema9: round(fast[lastIndex], 8),
    ema21: round(medium[lastIndex], 8),
    ema55: round(slow[lastIndex], 8),
    rsi14: round(strength, 2),
    atrPct: round(atrPct, 3),
    volumeRatio: round(volumeRatio, 3),
    momentum6Pct: round(momentum6Pct, 3),
    channelHigh20: round(channelHigh20, 8),
    channelLow10: round(channelLow10, 8),
    bollingerUpper: round(average20 + deviation20 * 2, 8),
    bollingerLower: round(average20 - deviation20 * 2, 8),
    candleCloseTime: new Date(last.closeTime).toISOString(),
  };

  const trendAligned = fast[lastIndex] > medium[lastIndex] && medium[lastIndex] > slow[lastIndex];
  const bullishCandle = last.close > last.open;
  const objections: string[] = [];
  if (atrPct > (definition.riskLevel === "low" ? 2.2 : definition.riskLevel === "medium" ? 3.2 : 4.5)) objections.push("短周期波动超过该策略容忍区间");
  if (strength >= 78) objections.push("RSI 进入明显过热区域");
  if (volumeRatio < 0.72) objections.push("成交量不足，信号可靠性下降");

  let entryCandidate = false;
  let exitCandidate = false;
  let baseConfidence = 45;
  let reason = "指标尚未形成一致方向，继续等待完整K线确认";

  if (definition.code === "ai_conservative") {
    entryCandidate = trendAligned && strength >= 48 && strength <= 67 && volumeRatio >= 0.8 && atrPct <= 2.2;
    exitCandidate = last.close < medium[lastIndex] || strength < 40 || strength > 76;
    baseConfidence = 44 + (trendAligned ? 22 : 0) + (strength >= 48 && strength <= 67 ? 13 : 0) + clamp((volumeRatio - 0.7) * 18, 0, 12) - (atrPct > 2.2 ? 18 : 0);
    if (entryCandidate) reason = "中长期均线多头排列，RSI 与成交量均处于稳健入场区间";
    if (exitCandidate) reason = "价格或动量跌出稳健策略持仓边界";
  } else if (definition.code === "ai_balanced") {
    const trendEntry = trendAligned && strength >= 44 && strength <= 72 && volumeRatio >= 0.82;
    const rangeEntry = last.close <= metrics.bollingerLower && strength <= 34 && bullishCandle;
    entryCandidate = (trendEntry || rangeEntry) && atrPct <= 3.2;
    exitCandidate = last.close < medium[lastIndex] && strength < 43 || strength > 79;
    baseConfidence = 43 + (trendAligned ? 18 : 0) + (rangeEntry ? 22 : 0) + (strength >= 44 && strength <= 72 ? 10 : 0) + clamp((volumeRatio - 0.7) * 17, 0, 13) - (atrPct > 3.2 ? 18 : 0);
    if (entryCandidate) reason = rangeEntry ? "价格触及布林下轨并出现超卖修复，区间模块提出入场" : "趋势、动量与成交量通过平衡策略联合确认";
    if (exitCandidate) reason = "趋势和动量同时转弱，平衡策略退出条件成立";
  } else {
    const breakout = last.close > channelHigh20 && volumeRatio >= 1.12;
    const momentum = momentum6Pct >= 1.1 && fast[lastIndex] > medium[lastIndex] && volumeRatio >= 1.02;
    entryCandidate = (breakout || momentum) && strength <= 80 && atrPct <= 4.5;
    exitCandidate = last.close < fast[lastIndex] || momentum6Pct <= -0.75 || last.close < channelLow10;
    baseConfidence = 42 + (breakout ? 24 : 0) + (momentum ? 18 : 0) + clamp((volumeRatio - 0.85) * 18, 0, 14) - (strength > 80 ? 20 : 0) - (atrPct > 4.5 ? 20 : 0);
    if (entryCandidate) reason = breakout ? "价格突破 20 根K线通道上沿且成交量放大" : "短周期动量和量能同步增强";
    if (exitCandidate) reason = "短周期动量反转或价格跌破动态退出线";
  }

  const confidence = Math.round(clamp(baseConfidence, 0, 99));
  let action: PlatformStrategyAction = "hold";
  if (hasOpenPosition && exitCandidate) action = "exit";
  if (!hasOpenPosition && entryCandidate && confidence >= definition.minimumConfidence && objections.length < 2) action = "enter";
  if (entryCandidate && action === "hold" && !hasOpenPosition) reason = `候选信号置信度 ${confidence}% 或反方异议未达到执行标准`;
  const approved = action !== "enter" || objections.length < 2 && confidence >= definition.minimumConfidence;

  return {
    action,
    confidence,
    reason,
    metrics,
    riskReview: {
      approved,
      risk: { ...definition.risk },
      leverageEnabled: false,
      shortSellingEnabled: false,
      fundingEnabled: false,
      objections,
    },
    agentMessages: signalMessages(definition, symbol, action, confidence, reason, metrics, objections),
  };
}
