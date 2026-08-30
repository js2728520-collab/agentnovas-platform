import type { ResolvedLlmConfig } from "./client-platform-llm.ts";
import { requestAiGatewayInvocation } from "./ai-gateway-client.ts";

export type AiProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TrustedAiUsage = {
  source: "provider_metering";
  providerRequestId: string;
  usageId: string;
  inputTokens: number;
  outputTokens: number;
};

export function boundedAiHistory(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  maximumMessages = 12,
  maximumCharacters = 16_000,
) {
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remaining = maximumCharacters;
  for (let index = messages.length - 1; index >= 0 && selected.length < maximumMessages && remaining > 0; index -= 1) {
    const message = messages[index];
    const content = message.content.slice(0,remaining);
    if (!content) continue;
    selected.unshift({ role: message.role,content });
    remaining -= content.length;
  }
  return selected;
}

export async function requestAiText(
  config: ResolvedLlmConfig,
  messages: AiProviderMessage[],
  options: {
    invocationId?: string;
    operation?: string;
    maxOutputTokens?: number;
    temperature?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    environment?: Record<string,string | undefined>;
  } = {},
) {
  const invocationId = options.invocationId ?? crypto.randomUUID();
  const result = await requestAiGatewayInvocation({
    invocationId,
    roleKey: config.roleKey,
    operation: options.operation ?? config.roleKey.slice("client.".length),
    payload: {
      messages,
      maxOutputTokens: options.maxOutputTokens ?? 500,
      temperature: options.temperature ?? 0.2,
    },
    signal: options.signal,fetchImpl: options.fetchImpl,environment: options.environment,
  });
  const text = result.content.trim();
  const usage = result.receipt.usage;
  if (result.receipt.status !== "succeeded" || !text || text.length > 8_000 || !usage
    || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens <= 0) {
    throw new Error("AI Gateway 未返回可靠内容与可信用量计量");
  }
  return {
    text,
    metering: {
      source: "provider_metering" as const,
      providerRequestId: invocationId,
      usageId: invocationId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}
