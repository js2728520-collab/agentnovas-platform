import type { ResolvedLlmConfig } from "@/lib/llm-config";

export type AiProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function responseOutputText(data: {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}) {
  return data.output_text?.trim()
    || data.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim()
    || "";
}

async function safeProviderError(response: Response, providerName: string) {
  const body = await response.json().catch(() => null) as {
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
  options: { maxOutputTokens?: number; temperature?: number } = {},
) {
  const maxOutputTokens = options.maxOutputTokens ?? 500;
  const body = config.apiStyle === "responses"
    ? { model: config.model, input: messages, max_output_tokens: maxOutputTokens }
    : {
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: maxOutputTokens,
      };
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(await safeProviderError(response, config.providerName));
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  const text = config.apiStyle === "responses"
    ? responseOutputText(data)
    : data.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("AI 服务没有返回有效内容");
  if (text.length > 8_000) throw new Error("AI 服务返回内容过长");
  return text;
}
