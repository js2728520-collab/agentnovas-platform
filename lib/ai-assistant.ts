import type { ResolvedLlmConfig } from "@/lib/client-platform-llm";
import {
  buildSessionWorkingMemory,
  classifyAssistantIntent,
  guidedAssistantReply,
  type AssistantContext,
} from "@/lib/ai-chat-protocol";
import { boundedAiHistory, requestAiText, type AiProviderMessage } from "@/lib/ai-provider";
import { strategyDraftFromAiMessage } from "@/lib/ai-strategy-save";
import { StrategyDslValidationError } from "@/packages/domain/src/strategy-dsl";
import type { UserAppLocale } from "@/lib/user-app-preference";

/**
 * 策略 DSL 修复循环的重试次数（不含首次生成）。
 *
 * 定为 1 是权衡的结果：把校验错误明确回喂给模型的那一次修正拿走了绝大部分收益，
 * 而每多一次尝试就要多预留一份 Credits——预留是临时冻结，未用部分会退回，
 * 但余额紧张的客户会因为冻结额度变大而被判「余额不足」。
 *
 * 改这个常量必须同步改 app/api/ai/conversations/[id]/messages 的预留倍数，
 * 否则结算会因为实耗超过预留而被拒（AI_CREDIT_RESERVATION_EXCEEDED）。
 */
export const STRATEGY_REPAIR_ATTEMPTS = 1;

/** 一次回复里的策略 DSL 是否能通过保存时的那道校验。 */
function strategyDslIssues(text: string): string[] | null {
  try {
    strategyDraftFromAiMessage(text);
    return null;
  } catch (error) {
    if (error instanceof StrategyDslValidationError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    return [error instanceof Error ? error.message : "策略 DSL 无法解析"];
  }
}

export type AssistantHistoryMessage = { role: "user" | "assistant"; content: string };

export function responseLanguageForLocale(locale: UserAppLocale | undefined) {
  const languages: Record<UserAppLocale, string> = {
    "en-US": "English",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "ru-RU": "Russian",
    "es-ES": "Spanish",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
  };
  return languages[locale ?? "zh-CN"];
}

export async function generateAssistantReply(options: {
  latestMessage: string;
  history: AssistantHistoryMessage[];
  context: AssistantContext;
  config: ResolvedLlmConfig | null;
  locale?: UserAppLocale;
  signal?: AbortSignal;
  invocationId?: string;
}) {
  const intent = classifyAssistantIntent(options.latestMessage);
  const memory = buildSessionWorkingMemory(options.history, options.latestMessage);
  if (!options.config) return guidedAssistantReply(options.latestMessage, options.context, memory);
  const responseLanguage = responseLanguageForLocale(options.locale);
  const system = `你是 Riverton Capital 的 AI 助手。你服务四类问题，不做闲聊式泛泛回答：
1. 行情分析——基于服务端行情快照解释走势、结构、支撑阻力与技术指标。
2. 决策分析——解释七智能体决策轮：这一轮做了什么判断，确定性风控为什么放行或拒绝。
3. 平台与网站信息——会员档位、AI 积分、绩效分成规则、官方策略卡参数、资金与权限边界。
4. 策略研究——把想法整理成平台可校验的 JSON DSL 草稿，供人工确认后回测。

安全边界：
1. 只做信息解释、风险教育和策略研究，不构成投资建议或收益承诺。
2. 本接口没有交易工具。禁止声称已经下单、调整仓位、连接交易密钥或启用实盘。
3. 不得索取密码、API Key、私钥或令牌；不得输出任意 Python 或可绕过平台校验的执行代码。
4. 只能使用服务端提供的客户摘要、行情快照、决策轮摘要与平台事实快照。数据缺失、过期或冲突时必须明确说明，不得编造。
5. 平台事实（会员价格、时长、AI 积分、绩效分成费率、策略卡风控参数、七阶段流程、资金与权限边界）只能逐项引用服务端平台快照。快照里没有的数字一律回答“以平台页面为准”，绝不推测、换算或凑出新数字——这些是合同事实，说错等于向客户虚假陈述。
6. 解释决策轮时只能引用决策轮摘要里的结论与拒绝理由，不得替风控重新判断，也不得暗示风控结论可以被模型覆盖。
7. 策略只能成为待人工确认、保存和回测的 JSON DSL 草稿。

回答合同：
- 先给“结论”，再给“关键证据”，随后说明“失效条件”，最后给一个可执行的“下一步”。
- 对具体市场问题，至少引用价格、周期、时间和一个技术指标；没有数据则直说不可用。
- 把事实、推断和待确认条件分开，不用空泛套话，不承诺结果。
- 已知字段不得重复询问；最多追问 2 个会实质改变结论的缺失条件。
- 需要客户确认时增加“待确认问题”区块；每个问题下一行写“候选：推荐项（推荐） | 备选项 | 备选项”，每题给 2 至 4 个互斥选项。
- 用户要求生成完整策略且关键条件已齐备时，必须增加“JSON DSL 草稿”区块，并在一个 json 代码块中只输出平台规范对象：schemaVersion 必须为 1；side 必须为 long_only；entry.all 为 1 至 4 条规则；exit.any 为 0 至 4 条规则，exit 还必须包含 stopLossPct、takeProfitPct；risk 必须包含 positionPct、maxDrawdownPct、dailyLossLimitPct、consecutiveLossLimit。规则仅允许 ema_cross(type,fastPeriod,slowPeriod,direction bullish/bearish)、rsi_threshold(type,period,operator lte/gte,value)、channel_breakout(type,period,direction above/below)、volume_ratio(type,period,operator lte/gte,value)。不要输出 operator、conditions、cross、enabled、capitalManagement 或额外字段。JSON 之外可以解释，但不得声称平台 Schema 未提供。
- 平台事实类问题不需要“失效条件”，但要说明数字来自平台合同常量；快照未提供的项目直接说未提供。
- 决策分析要按七阶段顺序讲，并明确指出哪一阶段给出了阻断理由；缺阶段时说明该轮不完整，不要补齐。
- Output language: ${responseLanguage}. 全部解释、标题、问题和候选项必须使用该语言；JSON DSL 的字段名和枚举值保持平台规范英文。通常不超过 800 字。

当前意图：${intent}
会话工作记忆：${JSON.stringify(memory)}
服务端研究上下文：${JSON.stringify(options.context)}`;
  const messages: AiProviderMessage[] = [
    { role: "system", content: system },
    ...boundedAiHistory(options.history),
  ];
  let response = await requestAiText(options.config, messages, {
    invocationId: options.invocationId ? `${options.invocationId}:primary` : undefined,
    operation: "assistant_message",
    maxOutputTokens: 900,
    temperature: 0.15,
    signal: options.signal,
  });
  const metering = { ...response.metering };
  const usageIds = [response.metering.usageId];

  // 策略 DSL 修复循环。
  //
  // 校验用的是 strategyDraftFromAiMessage——**保存时的同一道闸门**。用别的校验
  // 会「修复」出一个仍然存不进去的东西。不合格时把具体 issue 回喂给模型重来，
  // 而不是让客户看到 422 再自己重问。
  if (intent === "strategy_research") {
    for (let attempt = 0; attempt < STRATEGY_REPAIR_ATTEMPTS; attempt += 1) {
      const issues = strategyDslIssues(response.text);
      if (!issues) break;
      const repair = await requestAiText(options.config, [
        ...messages,
        { role: "assistant", content: response.text },
        {
          role: "user",
          content: `上一条回复里的 JSON DSL 未通过平台校验：\n${issues.join("\n")}\n\n`
            + "请按同样的回答结构重新输出完整回复（结论、关键证据、失效条件、下一步），"
            + "并修正 JSON DSL 草稿使其满足平台规范。只修正被指出的问题，不要改变策略意图。",
        },
      ], {
        invocationId: options.invocationId ? `${options.invocationId}:repair:${attempt + 1}` : undefined,
        operation: "assistant_message_repair",
        maxOutputTokens: 900,temperature: 0.15,signal: options.signal,
      });
      usageIds.push(repair.metering.usageId);
      metering.inputTokens += repair.metering.inputTokens;
      metering.outputTokens += repair.metering.outputTokens;
      metering.providerRequestId = repair.metering.providerRequestId;
      // 只在修复结果确实能通过校验时才采用；否则保留原回复，
      // 它至少还带着分析过程，而修复稿可能两头不着。
      if (!strategyDslIssues(repair.text)) {
        response = repair;
        break;
      }
    }
  }
  // 多次调用的用量必须合并上报，否则结算会按单次记账而少扣客户的钱。
  metering.usageId = usageIds.join("+");

  return {
    text: response.text,
    metering,
    mode: "ai_provider" as const,
    provider: options.config.providerName,
    model: options.config.model,
    suggestedAction: intent === "strategy_research" ? "strategy" as const : undefined,
  };
}
