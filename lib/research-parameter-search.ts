import type { ResearchMode } from "../packages/domain/src/research-validation.ts";
import {
  normalizeStrategyDslV3,
  strategyDslToRuntime,
  type StrategyConditionV3,
  type StrategyDslV3,
  type StrategyRule,
} from "../packages/domain/src/strategy-dsl.ts";

function seedFrom(value: string) {
  let seed = 0x811c9dc5;
  for (const character of value) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  return seed || 1;
}

function randomGenerator(seedValue: string) {
  let state = seedFrom(seedValue);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function scale(value: number, minimum: number, maximum: number, random: () => number, integer = false) {
  const scaled = Math.min(maximum, Math.max(minimum, value * (0.9 + random() * 0.2)));
  return integer ? Math.round(scaled) : Number(scaled.toFixed(4));
}

function mutateRule(rule: StrategyRule, random: () => number): StrategyRule {
  if (rule.type === "ema_cross") {
    const fastPeriod = scale(rule.fastPeriod, 2, 200, random, true);
    const slowPeriod = Math.max(fastPeriod + 1, scale(rule.slowPeriod, 3, 400, random, true));
    return { ...rule, fastPeriod, slowPeriod: Math.min(slowPeriod, 400) };
  }
  if (rule.type === "rsi_threshold") {
    return { ...rule, period: scale(rule.period, 2, 100, random, true), value: scale(rule.value, 1, 99, random) };
  }
  if (rule.type === "channel_breakout") {
    return { ...rule, period: scale(rule.period, 2, 200, random, true) };
  }
  if (rule.type === "volume_ratio") {
    return { ...rule, period: scale(rule.period, 2, 200, random, true), value: scale(rule.value, 0.1, 10, random) };
  }
  if (rule.type === "adx_threshold") {
    return { ...rule, period: scale(rule.period, 2, 100, random, true), value: scale(rule.value, 1, 100, random) };
  }
  if (rule.type === "bollinger_band") {
    return { ...rule, period: scale(rule.period, 2, 200, random, true), stdDev: scale(rule.stdDev, 0.5, 5, random) };
  }
  if (rule.type === "atr_volatility") {
    return { ...rule, period: scale(rule.period, 2, 100, random, true), valuePct: scale(rule.valuePct, 0.1, 20, random) };
  }
  if (rule.type === "ema_alignment") {
    const periods = rule.periods.map(period => scale(period, 2, 400, random, true));
    for (let index = 1; index < periods.length; index += 1) periods[index] = Math.max(periods[index], periods[index - 1] + 1);
    return { ...rule, periods };
  }
  if (rule.type === "price_ema") return { ...rule, period: scale(rule.period, 2, 400, random, true) };
  if (rule.type === "momentum") {
    return { ...rule, period: scale(rule.period, 1, 200, random, true), valuePct: scale(rule.valuePct, -50, 50, random) };
  }
  return rule;
}

function mutateCondition(condition: StrategyConditionV3, random: () => number): StrategyConditionV3 {
  if ("all" in condition) return { all: condition.all.map(item => mutateCondition(item, random)) };
  if ("any" in condition) return { any: condition.any.map(item => mutateCondition(item, random)) };
  if ("not" in condition) return { not: mutateCondition(condition.not, random) };
  return mutateRule(condition, random);
}

export function buildResearchParameterVariants(
  rawDsl: unknown,
  mode: ResearchMode,
  seed: string,
): StrategyDslV3[] {
  const baseline = strategyDslToRuntime(rawDsl);
  const count = mode === "deep" ? 5 : 2;
  const variants = [baseline];
  const random = randomGenerator(`${seed}:${JSON.stringify(baseline)}`);
  for (let index = 1; index < count; index += 1) {
    const candidate = structuredClone(baseline);
    for (const leg of [candidate.legs.long, candidate.legs.short]) {
      if (!leg) continue;
      leg.entry = mutateCondition(leg.entry, random);
      leg.exit = mutateCondition(leg.exit, random);
      leg.stopLossPct = scale(
        leg.stopLossPct,
        0.1,
        Math.min(20, candidate.risk.maxDrawdownPct - 0.0001),
        random,
      );
      leg.takeProfitPct = scale(leg.takeProfitPct, 0.1, 30, random);
    }
    variants.push(normalizeStrategyDslV3(candidate));
  }
  return variants;
}
