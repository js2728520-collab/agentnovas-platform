import { boundedAiHistory, requestAiText, type AiProviderMessage } from "./ai-provider.ts";
import { containsPotentialSecret } from "./ai-safety.ts";
import {
  normalizeStrategyDsl,
  strategyDslFromBrief,
  type StrategyRule,
} from "../packages/domain/src/strategy-dsl.ts";
import type { ResolvedLlmConfig } from "./client-platform-llm.ts";

const allowedBriefFields = new Set([
  "name", "symbol", "period", "timeframe", "style", "risk", "capital",
  "stopLoss", "takeProfit", "maxDrawdown", "dailyLossLimitPct",
  "consecutiveLossLimit", "indicators", "entryRule", "exitRule", "riskRule",
  "goal", "experience", "marketCondition", "frequency",
]);

export type StrategyBrief = Record<string, string> & {
  name: string;
  symbol: string;
  period: string;
  style: string;
};

function boundedString(value: unknown, field: string, maximum: number, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${field} 不能为空`);
  if (text.length > maximum) throw new Error(`${field} 不能超过 ${maximum} 个字符`);
  return text;
}

export function normalizeStrategyBrief(input: unknown): StrategyBrief {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("策略问卷必须是对象");
  const source = input as Record<string, unknown>;
  const unknown = Object.keys(source).find((key) => !allowedBriefFields.has(key));
  if (unknown) throw new Error(`策略问卷包含不支持的字段：${unknown}`);
  if (containsPotentialSecret(JSON.stringify(source))) {
    throw new Error("策略问卷包含疑似密钥、密码或令牌等敏感信息");
  }
  const result: StrategyBrief = {
    name: boundedString(source.name, "策略名称", 80, true),
    symbol: boundedString(source.symbol, "交易对", 24, true),
    period: boundedString(source.period ?? source.timeframe, "信号周期", 8, true),
    style: boundedString(source.style, "交易风格", 20, true),
  };
  const limits: Record<string, number> = {
    risk: 20,
    capital: 20,
    stopLoss: 20,
    takeProfit: 20,
    maxDrawdown: 20,
    dailyLossLimitPct: 20,
    consecutiveLossLimit: 20,
    indicators: 300,
    entryRule: 600,
    exitRule: 600,
    riskRule: 600,
    goal: 100,
    experience: 100,
    marketCondition: 120,
    frequency: 100,
  };
  for (const [field, maximum] of Object.entries(limits)) {
    if (source[field] !== undefined) result[field] = boundedString(source[field], field, maximum);
  }
  return result;
}

export function extractFirstJsonObject(value: string) {
  if (!value || value.length > 20_000) throw new Error("AI 策略响应为空或过长");
  const start = value.indexOf("{");
  if (start < 0) throw new Error("AI 策略响应中没有 JSON 对象");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  throw new Error("AI 策略 JSON 不完整");
}

export function extractStrategyDslFromText(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractFirstJsonObject(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AI 策略")) throw error;
    throw new Error("AI 策略 JSON 无法解析");
  }
  return normalizeStrategyDsl(parsed);
}

function ruleLabel(rule: StrategyRule) {
  if (rule.type === "ema_cross") return `EMA${rule.fastPeriod}/${rule.slowPeriod} ${rule.direction === "bullish" ? "金叉" : "死叉"}`;
  if (rule.type === "rsi_threshold") return `RSI${rule.period} ${rule.operator === "gte" ? "≥" : "≤"} ${rule.value}`;
  if (rule.type === "channel_breakout") return `${rule.period} 周期通道${rule.direction === "above" ? "向上" : "向下"}突破`;
  if (rule.type === "volume_ratio") return `成交量/${rule.period}周期均量 ${rule.operator === "gte" ? "≥" : "≤"} ${rule.value}`;
  if (rule.type === "adx_threshold") return `ADX${rule.period} ${rule.operator === "gte" ? "≥" : "≤"} ${rule.value}`;
  if (rule.type === "atr_volatility") return `ATR${rule.period}/价格 ${rule.operator === "gte" ? "≥" : "≤"} ${rule.valuePct}%`;
  if (rule.type === "bollinger_band") return `布林带${rule.period}/${rule.stdDev}σ ${rule.band === "upper" ? "上轨" : "下轨"}${rule.operator === "above" ? "上方" : "下方"}`;
  if (rule.type === "ema_alignment") return `EMA ${rule.periods.join("/")} ${rule.direction === "bullish" ? "多头" : "空头"}排列`;
  if (rule.type === "price_ema") return `价格位于 EMA${rule.period} ${rule.operator === "above" ? "上方" : "下方"}`;
  if (rule.type === "momentum") return `${rule.period} 周期动量 ${rule.operator === "gte" ? "≥" : "≤"} ${rule.valuePct}%`;
  return rule.direction === "bullish" ? "阳线" : "阴线";
}

export function strategyDslExplanation(input: unknown) {
  const specification = normalizeStrategyDsl(input);
  const entries = specification.entry.all.map(ruleLabel).join("，");
  const exits = specification.exit.any.length
    ? specification.exit.any.map(ruleLabel).join("，")
    : "仅固定止损止盈";
  return `入场需同时满足：${entries}。退出信号：${exits}；止损 ${specification.exit.stopLossPct}%，止盈 ${specification.exit.takeProfitPct}%。仓位 ${specification.risk.positionPct}%，最大回撤 ${specification.risk.maxDrawdownPct}%，单日亏损 ${specification.risk.dailyLossLimitPct}% 熔断。`;
}

export async function generateStrategyProposal(options: {
  brief: StrategyBrief;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  config: ResolvedLlmConfig | null;
  invocationId?: string;
}) {
  if (!options.config) {
    const specification = strategyDslFromBrief(options.brief);
    return {
      specification,
      explanation: strategyDslExplanation(specification),
      mode: "guided_rules" as const,
    };
  }

  const system = `你是 AgentNovas 的量化策略 DSL 生成器。只输出一个 JSON 对象，不要 Markdown、解释、代码或额外字段。禁止收益承诺，禁止交易指令，禁止 Python/JavaScript/SQL。schemaVersion 必须为 1；side 只能是 long_only；timeframe 只能是 5m/15m/1h/4h/1d。entry.all 为 1-4 条，exit.any 为 0-4 条。规则只允许：ema_cross(type,fastPeriod,slowPeriod,direction bullish/bearish)、rsi_threshold(type,period,operator lte/gte,value)、channel_breakout(type,period,direction above/below)、volume_ratio(type,period,operator lte/gte,value)。exit 还必须含 stopLossPct/takeProfitPct；risk 必须含 positionPct/maxDrawdownPct/dailyLossLimitPct/consecutiveLossLimit。不要添加 summary、reason、code 或 metadata。`;
  const messages: AiProviderMessage[] = [
    { role: "system", content: system },
    ...boundedAiHistory(options.history),
    { role: "user", content: `根据以下已校验问卷生成候选 DSL：${JSON.stringify(options.brief)}` },
  ];
  const response = await requestAiText(options.config,messages,{
    invocationId: options.invocationId,operation: "strategy_generation",
    maxOutputTokens: 1_200,temperature: 0.1,
  });
  const specification = extractStrategyDslFromText(response.text);
  return {
    specification,
    explanation: strategyDslExplanation(specification),
    mode: "ai_provider" as const,
    provider: options.config.providerName,
    model: options.config.model,
    metering: response.metering,
  };
}
