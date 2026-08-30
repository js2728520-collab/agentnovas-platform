import type { ProviderFailure, TokenUsage } from "./types.ts";

export type ProviderMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderTransportRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: AbortSignal;
};

export type ProviderTransportResponse = {
  status: number;
  headers?: Readonly<Record<string, string | undefined>>;
  body: unknown;
};

export type ProviderTransport = (request: ProviderTransportRequest) => Promise<ProviderTransportResponse>;

export type ProviderInvocationInput = {
  endpoint: string;
  apiKey: string;
  modelId: string;
  messages: readonly ProviderMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type ProviderInvocationResult = {
  content: string;
  providerRequestId?: string;
  usage: TokenUsage;
};

export interface ProviderAdapter {
  readonly id: string;
  discoverModels(input: { endpoint: string; apiKey: string; signal?: AbortSignal }): Promise<readonly string[]>;
  probe(input: ProviderInvocationInput): Promise<ProviderInvocationResult>;
  invoke(input: ProviderInvocationInput): Promise<ProviderInvocationResult>;
  classifyError(error: unknown): ProviderFailure;
}

type ProviderPayload = {
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  output_text?: unknown;
  output?: Array<{ content?: Array<{ text?: unknown }> }>;
  choices?: Array<{ message?: { content?: unknown } }>;
};

function baseEndpoint(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|responses)$/i, "");
}

function exactUsage(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function header(headers: ProviderTransportResponse["headers"], name: string) {
  if (!headers) return undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function createOpenAiCompatibleAdapter(options: { transport: ProviderTransport }): ProviderAdapter {
  return {
    id: "openai-compatible",
    async discoverModels(input) {
      const response = await options.transport({
        url: `${baseEndpoint(input.endpoint)}/models`,
        method: "GET",
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: input.signal,
      });
      if (response.status < 200 || response.status >= 300) throw this.classifyError({ status: response.status });
      const rows = (response.body as { data?: unknown } | null)?.data;
      if (!Array.isArray(rows)) return [];
      return [...new Set(rows.flatMap((row) => {
        const id = row && typeof row === "object" && "id" in row ? String(row.id).trim() : "";
        return id && id.length <= 200 ? [id] : [];
      }))].sort();
    },
    async probe(input) {
      return this.invoke({ ...input, messages: [{ role: "user", content: "Reply with OK only." }], maxOutputTokens: 1 });
    },
    async invoke(input) {
      const responsesStyle = /\/responses\/?$/i.test(input.endpoint);
      const url = responsesStyle ? input.endpoint.replace(/\/+$/, "") : `${baseEndpoint(input.endpoint)}/chat/completions`;
      const body = responsesStyle
        ? { model: input.modelId, input: input.messages, max_output_tokens: input.maxOutputTokens }
        : { model: input.modelId, messages: input.messages, max_tokens: input.maxOutputTokens };
      const response = await options.transport({
        url,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
        body,
        signal: input.signal,
      });
      if (response.status < 200 || response.status >= 300) throw this.classifyError({ status: response.status });
      const payload = response.body && typeof response.body === "object"
        ? response.body as ProviderPayload
        : {};
      const usage = payload?.usage ?? {};
      const content = responsesStyle
        ? String(payload?.output_text ?? payload?.output?.[0]?.content?.[0]?.text ?? "")
        : String(payload?.choices?.[0]?.message?.content ?? "");
      const inputTokens = exactUsage(responsesStyle ? usage.input_tokens : usage.prompt_tokens);
      const outputTokens = exactUsage(responsesStyle ? usage.output_tokens : usage.completion_tokens);
      const cachedInputTokens = exactUsage(responsesStyle
        ? usage.input_tokens_details?.cached_tokens
        : usage.prompt_tokens_details?.cached_tokens);
      return {
        content,
        ...(header(response.headers, "x-request-id") ? { providerRequestId: header(response.headers, "x-request-id") } : {}),
        usage: {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        },
      };
    },
    classifyError(error) {
      const value = error as { code?: unknown; status?: unknown; name?: unknown } | null;
      const code = typeof value?.code === "string" ? value.code : "";
      if (code === "cancelled" || code === "timeout" || code === "validation"
        || code === "authentication" || code === "configuration" || code === "budget"
        || code === "permission" || code === "output_contract") {
        return { code };
      }
      if (value?.name === "AbortError") return { code: "timeout" };
      const status = Number.isInteger(value?.status) ? Number(value?.status) : undefined;
      if (status === 401 || status === 403) return { code: "authentication", status };
      if (status === 429) return { code: "rate_limited", status };
      if (status !== undefined && status >= 500) return { code: "provider_5xx", status };
      if (status !== undefined && status >= 400) return { code: "validation", status };
      return { code: "network" };
    },
  };
}
