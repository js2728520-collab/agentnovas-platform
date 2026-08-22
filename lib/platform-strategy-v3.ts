import {
  PLATFORM_AI_STRATEGIES,
  type PlatformStrategyCode,
} from "./platform-ai-strategies.ts";
import {
  createStrategyLegEvaluator,
  type StrategyCandle,
  type StrategyConditionV3,
} from "./strategy-dsl.ts";
import { hashResearchStepInput } from "./research-steps.ts";
import type { OfficialTradingHallStrategy } from "../packages/contracts/src/trading-hall.ts";

export type OfficialSpotStrategySpecification = {
  schemaVersion: "official_spot_v1";
  strategyCode: PlatformStrategyCode;
  name: string;
  product: "spot_usdt";
  symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  timeframe: "5m" | "15m" | "1h";
  direction: "long_only";
  execution: {
    leverageEnabled: false;
    shortSellingEnabled: false;
    fundingEnabled: false;
    realOrderRoutingEnabled: false;
  };
  legs: { long: { entry: StrategyConditionV3; exit: StrategyConditionV3 } };
  risk: OfficialTradingHallStrategy["risk"];
};

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

export function platformStrategyDslV3(code: PlatformStrategyCode, symbol: string): OfficialSpotStrategySpecification {
  const definition = PLATFORM_AI_STRATEGIES[code];
  if (!(definition.symbols as readonly string[]).includes(symbol)) throw new Error(`${definition.name} 不支持该交易对`);
  return {
    schemaVersion: "official_spot_v1",
    strategyCode: code,
    name: `${definition.name} · ${symbol}`,
    product: "spot_usdt",
    symbol: symbol as OfficialSpotStrategySpecification["symbol"],
    timeframe: definition.interval,
    direction: "long_only",
    execution: {
      leverageEnabled: false,
      shortSellingEnabled: false,
      fundingEnabled: false,
      realOrderRoutingEnabled: false,
    },
    legs: { long: {
      entry: entryFor(code),
      exit: exitFor(code),
    } },
    risk: { ...definition.risk },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeOfficialSpotStrategySpecification(value: unknown): OfficialSpotStrategySpecification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "official_spot_v1") return null;
  const code = String(candidate.strategyCode || "") as PlatformStrategyCode;
  if (!(code in PLATFORM_AI_STRATEGIES)) throw new Error("官方现货策略代码无效");
  const expected = platformStrategyDslV3(code, String(candidate.symbol || ""));
  if (canonicalJson(candidate) !== canonicalJson(expected)) throw new Error("官方现货策略规格与平台合同不一致");
  return expected;
}

export function evaluateConvertedPlatformStrategy(
  dsl: OfficialSpotStrategySpecification,
  candles: StrategyCandle[],
  hasOpenPosition: boolean,
) {
  const evaluator = createStrategyLegEvaluator({
    ...dsl.legs.long,
    stopLossPct: 1,
    takeProfitPct: 1,
  }, candles);
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
