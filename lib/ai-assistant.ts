import type { ResolvedLlmConfig } from "@/lib/llm-config";
import {
  buildSessionWorkingMemory,
  classifyAssistantIntent,
  guidedAssistantReply,
  type AssistantContext,
} from "@/lib/ai-chat-protocol";
import { boundedAiHistory, requestAiText, type AiProviderMessage } from "@/lib/ai-provider";

export type AssistantHistoryMessage = { role: "user" | "assistant"; content: string };

export async function generateAssistantReply(options: {
  latestMessage: string;
  history: AssistantHistoryMessage[];
  context: AssistantContext;
  config: ResolvedLlmConfig | null;
}) {
  const intent = classifyAssistantIntent(options.latestMessage);
  const memory = buildSessionWorkingMemory(options.history, options.latestMessage);
  if (!options.config) return guidedAssistantReply(options.latestMessage, options.context, memory);
  const system = `你是 AgentNovas 的专业量化研究助手。你的任务是帮助客户完成行情研究、持仓风险解释、策略研究和回测解读，而不是闲聊式泛泛回答。

安全边界：
1. 只做信息解释、风险教育和策略研究，不构成投资建议或收益承诺。
2. 本接口没有交易工具。禁止声称已经下单、调整仓位、连接交易密钥或启用实盘。
3. 不得索取密码、API Key、私钥或令牌；不得输出任意 Python 或可绕过平台校验的执行代码。
4. 只能使用服务端提供的客户摘要与行情研究快照。数据缺失、过期或冲突时必须明确说明，不得编造。
5. 策略只能成为待人工确认、保存和回测的 JSON DSL 草稿。

回答合同：
- 先给“结论”，再给“关键证据”，随后说明“失效条件”，最后给一个可执行的“下一步”。
- 对具体市场问题，至少引用价格、周期、时间和一个技术指标；没有数据则直说不可用。
- 把事实、推断和待确认条件分开，不用空泛套话，不承诺结果。
- 已知字段不得重复询问；最多追问 2 个会实质改变结论的缺失条件。
- 需要客户确认时增加“待确认问题”区块；每个问题下一行写“候选：推荐项（推荐） | 备选项 | 备选项”，每题给 2 至 4 个互斥选项。
- 用户要求生成完整策略且关键条件已齐备时，必须增加“JSON DSL 草稿”区块，并在一个 json 代码块中只输出平台规范对象：schemaVersion 必须为 1；side 必须为 long_only；entry.all 为 1 至 4 条规则；exit.any 为 0 至 4 条规则，exit 还必须包含 stopLossPct、takeProfitPct；risk 必须包含 positionPct、maxDrawdownPct、dailyLossLimitPct、consecutiveLossLimit。规则仅允许 ema_cross(type,fastPeriod,slowPeriod,direction bullish/bearish)、rsi_threshold(type,period,operator lte/gte,value)、channel_breakout(type,period,direction above/below)、volume_ratio(type,period,operator lte/gte,value)。不要输出 operator、conditions、cross、enabled、capitalManagement 或额外字段。JSON 之外可以解释，但不得声称平台 Schema 未提供。
- 使用简洁中文，通常不超过 800 字。

当前意图：${intent}
会话工作记忆：${JSON.stringify(memory)}
服务端研究上下文：${JSON.stringify(options.context)}`;
  const messages: AiProviderMessage[] = [
    { role: "system", content: system },
    ...boundedAiHistory(options.history),
  ];
  const text = await requestAiText(options.config, messages, { maxOutputTokens: 900, temperature: 0.15 });
  return {
    text,
    mode: "ai_provider" as const,
    provider: options.config.providerName,
    model: options.config.model,
    suggestedAction: intent === "strategy_research" ? "strategy" as const : undefined,
  };
}
