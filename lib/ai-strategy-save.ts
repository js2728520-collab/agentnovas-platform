import {
  extractFirstJsonObject,
  extractStrategyDslFromText,
  strategyDslExplanation,
} from "./ai-strategy-generation.ts";
import { normalizeStrategyDsl, type StrategyRule } from "../packages/domain/src/strategy-dsl.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function emaPeriods(value: unknown) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const periods = value.slice(0, 2).map((item) => Number(String(item).match(/\d+/)?.[0]));
  if (!periods.every(Number.isFinite)) return null;
  const [first, second] = periods;
  return { fastPeriod: Math.min(first, second), slowPeriod: Math.max(first, second) };
}

function directStrategyRule(value: unknown): StrategyRule | null {
  const rule = record(value);
  if (rule.type === "ema_cross") {
    const fastPeriod = Number(rule.fastPeriod);
    const slowPeriod = Number(rule.slowPeriod);
    if (!Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod)) return null;
    const directionValue = String(rule.direction ?? rule.cross ?? "").toLowerCase();
    const direction = ["bullish", "above", "up"].includes(directionValue)
      ? "bullish" as const
      : ["bearish", "below", "down"].includes(directionValue)
        ? "bearish" as const
        : null;
    return direction ? { type: "ema_cross", fastPeriod, slowPeriod, direction } : null;
  }
  if (rule.type === "volume_ratio" || rule.type === "rsi_threshold") {
    const period = Number(rule.period);
    const threshold = Number(rule.value);
    if (!Number.isFinite(period) || !Number.isFinite(threshold)) return null;
    const operatorValue = String(rule.operator || "").toLowerCase();
    const operator = ["gte", ">="].includes(operatorValue)
      ? "gte" as const
      : ["lte", "<="].includes(operatorValue)
        ? "lte" as const
        : null;
    if (!operator) return null;
    return rule.type === "volume_ratio"
      ? { type: "volume_ratio", period, operator, value: threshold }
      : { type: "rsi_threshold", period, operator, value: threshold };
  }
  if (rule.type === "channel_breakout") {
    const period = Number(rule.period);
    if (!Number.isFinite(period) || (rule.direction !== "above" && rule.direction !== "below")) return null;
    return { type: "channel_breakout", period, direction: rule.direction };
  }
  return null;
}

function ruleCandidates(container: Record<string, unknown>, nestedKey?: string) {
  if (Array.isArray(container.all)) return container.all;
  if (Array.isArray(container.conditions)) return container.conditions;
  if (nestedKey) {
    const nested = record(container[nestedKey]);
    if (Array.isArray(nested.all)) return nested.all;
  }
  return [];
}

function compatibleStrategyDsl(content: string) {
  try {
    return { specification: extractStrategyDslFromText(content), conversionWarnings: [] as string[] };
  } catch {
    const source = record(JSON.parse(extractFirstJsonObject(content)));
    if (typeof source.symbol !== "string" || !source.symbol.trim()) {
      throw new Error("扩展策略缺少明确交易对");
    }
    if (typeof source.timeframe !== "string" || !source.timeframe.trim()) {
      throw new Error("扩展策略缺少明确信号周期");
    }
    if (source.side !== undefined && source.side !== "long" && source.side !== "long_only") {
      throw new Error("当前回测 DSL 仅支持仅做多策略");
    }
    const capital = record(source.capitalManagement || source.risk);
    const entry = record(source.entry);
    const entryCandidates = ruleCandidates(entry, "when");
    const entryRules: StrategyRule[] = [];
    for (const candidate of entryCandidates) {
      const rule = record(candidate);
      const direct = directStrategyRule(rule);
      if (direct) {
        entryRules.push(direct);
        continue;
      }
      const cross = emaPeriods(rule.crossesAbove);
      if (cross) entryRules.push({ type: "ema_cross", ...cross, direction: "bullish" });
      const volume = Array.isArray(rule.gt) ? rule.gt : Array.isArray(rule.gte) ? rule.gte : [];
      if (String(volume[0] || "").toLowerCase() === "volume" && /vol(?:ume)?sma(\d+)/i.test(String(volume[1] || ""))) {
        entryRules.push({
          type: "volume_ratio",
          period: Number(String(volume[1]).match(/\d+/)?.[0] || 20),
          operator: "gte",
          value: 1,
        });
      }
    }
    if (!entryRules.length) throw new Error("扩展策略中没有当前回测引擎支持的入场规则");

    const exit = record(source.exit);
    const exitCandidates = Array.isArray(exit.any)
      ? exit.any
      : Array.isArray(exit.conditions)
        ? exit.conditions
        : [];
    const exitRules: StrategyRule[] = [];
    let stopLossPct = boundedNumber(exit.stopLossPct ?? capital.stopLossPct, 2, 0.1, 20);
    let takeProfitPct = boundedNumber(exit.takeProfitPct ?? capital.takeProfitPct, 4, 0.1, 30);
    for (const candidate of exitCandidates) {
      const rule = record(candidate);
      const direct = directStrategyRule(rule);
      if (direct) {
        exitRules.push(direct);
        continue;
      }
      const when = record(rule.when);
      const cross = emaPeriods(when.crossesBelow);
      if (cross) exitRules.push({ type: "ema_cross", ...cross, direction: "bearish" });
      if (when.stopLossPct !== undefined) stopLossPct = boundedNumber(when.stopLossPct, 2, 0.1, 20);
      if (when.takeProfitPct !== undefined) takeProfitPct = boundedNumber(when.takeProfitPct, 4, 0.1, 30);
    }

    const maxDrawdownPct = Math.max(
      stopLossPct + 0.5,
      boundedNumber(capital.maxDrawdownPct, 10, 1, 50),
    );
    const serialized = JSON.stringify(source);
    const conversionWarnings = [
      /ADX/i.test(serialized) ? "ADX 过滤暂不受当前回测 DSL 支持，保存版本未包含该条件" : "",
      /trailBy|trailing|移动止损/i.test(serialized) ? "ATR 移动止损暂不受当前回测 DSL 支持，保存版本保留固定止损止盈" : "",
    ].filter(Boolean);
    return {
      specification: normalizeStrategyDsl({
        schemaVersion: 1,
        name: String(source.name || "AI 对话策略").slice(0, 80),
        symbol: source.symbol,
        timeframe: source.timeframe,
        side: "long_only",
        entry: { all: entryRules.slice(0, 4) },
        exit: {
          any: exitRules.slice(0, 4),
          stopLossPct,
          takeProfitPct,
        },
        risk: {
          positionPct: boundedNumber(capital.positionPct, 3, 0.1, 30),
          maxDrawdownPct,
          dailyLossLimitPct: boundedNumber(capital.dailyLossLimitPct, 2, 0.5, 20),
          consecutiveLossLimit: Math.round(boundedNumber(
            record(capital.pauseAfterConsecutiveLosses).lossCount ?? capital.consecutiveLossLimit,
            3,
            1,
            10,
          )),
        },
      }),
      conversionWarnings,
    };
  }
}

export function strategyDraftFromAiMessage(content: string) {
  const { specification, conversionWarnings } = compatibleStrategyDsl(content);
  const maxDrawdownPct = specification.risk.maxDrawdownPct;
  const riskLevel = maxDrawdownPct <= 10
    ? "low" as const
    : maxDrawdownPct <= 20
      ? "medium" as const
      : "high" as const;

  return {
    name: specification.name,
    summary: `${specification.symbol.replace(/USDT$/, "/USDT")} · ${specification.timeframe} · ${strategyDslExplanation(specification)}${conversionWarnings.length ? ` 兼容提示：${conversionWarnings.join("；")}` : ""}`,
    riskLevel,
    publicationMode: "self_use" as const,
    specification,
    conversionWarnings,
  };
}
