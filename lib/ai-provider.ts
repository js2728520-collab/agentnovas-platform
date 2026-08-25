import type { ResolvedLlmConfig } from "@/lib/client-platform-llm";

import { assertPublicLlmEndpoint } from "./llm-profile-connection.ts";

type LlmDnsResolver = (hostname: string) => Promise<Array<{ address: string }>>;

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
    const content = message.content.slice(0, remaining);
    if (!content) continue;
    selected.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return selected;
}

function responseOutputText(data: {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}) {
  return data.output_text?.trim()
    || data.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim()
    || "";
}

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

async function boundedJson(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("AI 服务响应过大");
  }
  if (!response.body) return JSON.parse("") as Record<string, unknown>;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AI 服务响应过大");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function safeProviderError(response: Response, providerName: string) {
  const body = await boundedJson(response).catch(() => null) as {
    error?: { message?: string } | string;
    message?: string;
  } | null;
  const detail = typeof body?.error === "string"
    ? body.error
    : body?.error?.message || body?.message || "";
  return `${providerName} 返回 ${response.status}${detail ? `：${detail.slice(0, 160)}` : ""}`;
}

export async function requestAiText(
  config: ResolvedLlmConfig,
  messages: AiProviderMessage[],
  options: {
    maxOutputTokens?: number;
    temperature?: number;
    fetchImpl?: typeof fetch;
    resolver?: LlmDnsResolver;
    signal?: AbortSignal;
  } = {},
) {
  if (options.signal?.aborted) throw options.signal.reason;
  await assertPublicLlmEndpoint(config.endpoint, options.resolver);
  if (options.signal?.aborted) throw options.signal.reason;
  const maxOutputTokens = options.maxOutputTokens ?? 500;
  const body = config.apiStyle === "responses"
    ? { model: config.model, input: messages, max_output_tokens: maxOutputTokens }
    : {
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: maxOutputTokens,
      };
  const timeoutSignal = AbortSignal.timeout(45_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await (options.fetchImpl ?? fetch)(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    redirect: "error",
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(await safeProviderError(response, config.providerName));
  const data = await boundedJson(response) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  const text = config.apiStyle === "responses"
    ? responseOutputText(data)
    : data.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("AI 服务没有返回有效内容");
  if (text.length > 8_000) throw new Error("AI 服务返回内容过长");
  const providerRequestId = data.id?.trim() ?? "";
  const inputTokens = config.apiStyle === "responses"
    ? data.usage?.input_tokens
    : data.usage?.prompt_tokens;
  const outputTokens = config.apiStyle === "responses"
    ? data.usage?.output_tokens
    : data.usage?.completion_tokens;
  if (
    !providerRequestId || providerRequestId.length > 200
    || !Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0
    || !Number.isSafeInteger(outputTokens) || Number(outputTokens) <= 0
  ) {
    throw new Error("AI 服务未返回可靠的请求标识与用量计量");
  }
  return {
    text,
    metering: {
      source: "provider_metering" as const,
      providerRequestId,
      usageId: providerRequestId,
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
    },
  };
}
