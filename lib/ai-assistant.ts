import type { ResolvedLlmConfig } from "@/lib/llm-config";
import { guidedAssistantReply, type AssistantContext } from "@/lib/ai-chat-protocol";
import { boundedAiHistory, requestAiText, type AiProviderMessage } from "@/lib/ai-provider";

export type AssistantHistoryMessage = { role: "user" | "assistant"; content: string };

export async function generateAssistantReply(options: {
  latestMessage: string;
  history: AssistantHistoryMessage[];
  context: AssistantContext;
  config: ResolvedLlmConfig | null;
}) {
  if (!options.config) return guidedAssistantReply(options.latestMessage, options.context);
  const system = `你是 AgentNovas 的客户量化研究助手。只做信息解释、风险教育和策略研究，不构成投资建议或收益承诺。禁止声称已经下单、修改仓位、连接交易密钥或启用实盘；本接口没有任何交易工具。只能使用下方服务端提供的当前客户摘要，不得索取密码、API Key、私钥或令牌。行情缺失时明确说不可用，不得编造。若用户要生成策略，引导其进入策略工作室，策略只能成为待人工确认和回测的 JSON DSL 草稿。回复使用简洁中文，不超过 500 字。当前客户摘要：${JSON.stringify(options.context)}`;
  const messages: AiProviderMessage[] = [
    { role: "system", content: system },
    ...boundedAiHistory(options.history),
  ];
  const text = await requestAiText(options.config, messages, { maxOutputTokens: 600, temperature: 0.2 });
  return {
    text,
    mode: "ai_provider" as const,
    provider: options.config.providerName,
    model: options.config.model,
    suggestedAction: /生成|创建|编写|策略/.test(options.latestMessage) ? "strategy" as const : undefined,
  };
}
