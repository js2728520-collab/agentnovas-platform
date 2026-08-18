import {
  PLATFORM_AI_STRATEGIES,
  type PlatformStrategyCode,
  type PlatformStrategyDefinition,
} from "./platform-ai-strategies.ts";
import {
  createStrategyLegEvaluator,
  normalizeStrategyDslV3,
  type StrategyCandle,
  type StrategyConditionV3,
  type StrategyDslV3,
} from "./strategy-dsl.ts";
import { hashResearchStepInput } from "./research-steps.ts";

const simpleRsi = (operator: "lt" | "lte" | "gte" | "gt", value: number) => ({
  type: "rsi_threshold" as const,
  period: 14,
  operator,
  value,
  smoothing: "simple_window" as const,
});
const legacyAtrBelow = (valuePct: number) => ({
  type: "atr_volatility" as const,
  period: 14,
  operator: "lte" as const,
  valuePct,
  smoothing: "simple_window" as const,
});
const legacyVolumeAbove = (value: number) => ({
  type: "volume_ratio" as const,
  period: 20,
  operator: "gte" as const,
  value,
  average: "ema_inclusive" as const,
});

function entryFor(code: PlatformStrategyCode): StrategyConditionV3 {
  if (code === "ai_conservative") {
    return { all: [
      { type: "ema_alignment", periods: [9, 21, 55], direction: "bullish" },
      simpleRsi("gte", 48),
      simpleRsi("lte", 67),
      legacyVolumeAbove(0.8),
      legacyAtrBelow(2.2),
    ] };
  }
  if (code === "ai_balanced") {
    const trend: StrategyConditionV3 = { all: [
      { type: "ema_alignment", periods: [9, 21, 55], direction: "bullish" },
      simpleRsi("gte", 44),
      simpleRsi("lte", 72),
      legacyVolumeAbove(0.82),
    ] };
    const rangeBase: StrategyConditionV3[] = [
      { type: "bollinger_band", period: 20, stdDev: 2, band: "lower", operator: "lte" },
      simpleRsi("lte", 34),
      { type: "candle_direction", direction: "bullish" },
    ];
    return { any: [
      { all: [...trend.all, legacyAtrBelow(3.2)] },
      { all: [...rangeBase, { type: "ema_alignment", periods: [9, 21, 55], direction: "bullish" }, legacyAtrBelow(3.2)] },
      // Math.round(baseConfidence) >= 68 when the raw volume contribution is >= 2.5.
      { all: [...rangeBase, legacyVolumeAbove(0.7 + 2.5 / 17), legacyAtrBelow(3.2)] },
    ] };
  }
  const breakout: StrategyConditionV3[] = [
    { type: "channel_breakout", period: 20, direction: "above" },
    legacyVolumeAbove(1.12),
  ];
  const momentum: StrategyConditionV3[] = [
    { type: "momentum", period: 6, operator: "gte", valuePct: 1.1 },
    { type: "ema_alignment", periods: [9, 21], direction: "bullish" },
  ];
  return { any: [
    { all: [...breakout, ...momentum, simpleRsi("lte", 80), legacyAtrBelow(4.5)] },
    { all: [
      { type: "channel_breakout", period: 20, direction: "above" },
      legacyVolumeAbove(0.85 + 8.5 / 18),
      simpleRsi("lte", 80),
      legacyAtrBelow(4.5),
    ] },
  ] };
}

function exitFor(code: PlatformStrategyCode): StrategyConditionV3 {
  if (code === "ai_conservative") {
    return { any: [
      { type: "price_ema", period: 21, operator: "below" },
      simpleRsi("lt", 40),
      simpleRsi("gt", 76),
    ] };
  }
  if (code === "ai_balanced") {
    return { any: [
      { all: [
        { type: "price_ema", period: 21, operator: "below" },
        simpleRsi("lt", 43),
      ] },
      simpleRsi("gt", 79),
    ] };
  }
  return { any: [
    { type: "price_ema", period: 9, operator: "below" },
    { type: "momentum", period: 6, operator: "lte", valuePct: -0.75 },
    { type: "channel_breakout", period: 10, direction: "below" },
  ] };
}

function riskFor(definition: PlatformStrategyDefinition) {
  const maxDrawdownPct = definition.riskLevel === "low" ? 8 : definition.riskLevel === "medium" ? 12 : 16;
  return {
    positionSizePct: definition.maxCapitalPct,
    maxDrawdownPct,
    maxDailyLossPct: definition.riskLevel === "low" ? 2 : definition.riskLevel === "medium" ? 3 : 4,
    maxConsecutiveLosses: definition.riskLevel === "low" ? 3 : definition.riskLevel === "medium" ? 4 : 5,
  };
}

export function platformStrategyDslV3(code: PlatformStrategyCode, symbol: string): StrategyDslV3 {
  const definition = PLATFORM_AI_STRATEGIES[code];
  if (!definition.symbols.includes(symbol)) throw new Error(`${definition.name} 不支持该交易对`);
  return normalizeStrategyDslV3({
    schemaVersion: 3,
    name: `${definition.name} · ${symbol}`,
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol,
    timeframe: definition.interval,
    direction: "long_only",
    legs: { long: {
      entry: entryFor(code),
      exit: exitFor(code),
      stopLossPct: definition.stopLossPct,
      takeProfitPct: definition.takeProfitPct,
    } },
    risk: riskFor(definition),
  });
}

export function evaluateConvertedPlatformStrategy(
  dsl: StrategyDslV3,
  candles: StrategyCandle[],
  hasOpenPosition: boolean,
) {
  const evaluator = createStrategyLegEvaluator(dsl.legs.long!, candles);
  const index = candles.length - 1;
  if (hasOpenPosition && evaluator.exitAt(index)) return "exit" as const;
  if (!hasOpenPosition && evaluator.entryAt(index)) return "enter" as const;
  return "hold" as const;
}

export function allPlatformStrategyDslV3() {
  return (Object.keys(PLATFORM_AI_STRATEGIES) as PlatformStrategyCode[]).flatMap(code =>
    PLATFORM_AI_STRATEGIES[code].symbols.map(symbol => ({ code, symbol, dsl: platformStrategyDslV3(code, symbol) })),
  );
}

export async function platformStrategyConversionContractHash() {
  return hashResearchStepInput(allPlatformStrategyDslV3());
}
