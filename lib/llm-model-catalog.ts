/**
 * 拉取供应商的可选模型列表，以及「保存前先测」。
 *
 * 补的是流程上的一个反向依赖：此前唯一的连通测试接口是
 * `/api/admin/agent-role-bindings/test`，它测的是**已绑定到生产角色**的 Profile。
 * 于是流程被迫成为
 *
 *     建 Profile（不知道对不对）→ 绑定到生产角色 → 才能测
 *
 * ——必须先把一个未经验证的配置绑到生产角色上，才能验证它。这里让「填地址和密钥 →
 * 测试 → 拿模型列表」在保存之前就能完成。
 */

import type { LookupAddress } from "node:dns";

import { assertPublicLlmEndpoint } from "./llm-profile-connection.ts";
import { normalizeLlmCompletionEndpoint, normalizeLlmModelsEndpoint } from "./llm-endpoint.ts";

export type LlmProbeInput = {
  baseUrl: string;
  apiKey: string;
  /** 指定模型时顺带做一次真实补全调用；不指定则只拉列表。 */
  modelName?: string;
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
};

export type LlmProbeResult = {
  ok: true;
  latencyMs: number;
  /** 供应商返回的模型 id 列表。拉不到时为 null——不阻断，运维可手输。 */
  models: string[] | null;
  modelsUnavailableReason: string | null;
  /** 指定了 modelName 时，这里是那次补全调用的结果。 */
  completion: { ok: boolean; latencyMs: number; apiStyle: string } | null;
};

function clampTimeout(value: number | undefined) {
  return Math.min(Math.max(value ?? 12_000, 1_000), 30_000);
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`连接超时（${timeoutMs / 1_000} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 HTTP 状态翻译成运维看得懂的原因。裸 status 码要人去查文档。 */
function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return "API Key 无效或没有权限";
  if (status === 404) return "接口路径不存在——检查 base_url 是否少了或多了 /v1";
  if (status === 429) return "供应商限流，稍后重试";
  if (status >= 500) return `供应商服务异常（HTTP ${status}）`;
  return `模型服务返回 HTTP ${status}`;
}

/**
 * 拉模型列表。
 *
 * **拉不到不算失败。** 有些中转站和自建网关不实现 `/models`，但补全接口是好的。
 * 把它当成硬错误会挡住一批完全可用的配置；返回 null 并说明原因，让运维手输模型名。
 */
async function fetchModelList(input: LlmProbeInput, timeoutMs: number): Promise<{
  models: string[] | null;
  reason: string | null;
}> {
  let endpoint: string;
  try {
    endpoint = normalizeLlmModelsEndpoint(input.baseUrl);
  } catch (error) {
    return { models: null, reason: error instanceof Error ? error.message : "接口地址无效" };
  }
  try {
    await assertPublicLlmEndpoint(endpoint, input.resolver);
    const response = await withTimeout(timeoutMs, (signal) =>
      (input.fetchImpl ?? fetch)(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal,
        redirect: "error",
      }));
    if (!response.ok) return { models: null, reason: describeHttpFailure(response.status) };

    const payload = await response.json().catch(() => null) as { data?: unknown } | null;
    const rows = Array.isArray(payload?.data) ? payload.data : null;
    if (!rows) return { models: null, reason: "供应商未按 OpenAI 协议返回模型列表" };

    const models = rows
      .map((row) => (row && typeof row === "object" && "id" in row ? String((row as { id: unknown }).id) : ""))
      .filter((id) => id.length > 0 && id.length <= 200)
      .sort();
    // 去重：OpenRouter 这类聚合站偶尔会重复列出同一个 id。
    return { models: [...new Set(models)], reason: null };
  } catch (error) {
    return { models: null, reason: error instanceof Error ? error.message : "无法获取模型列表" };
  }
}

/** 用指定模型做一次最小补全调用，确认这个模型真的可用。 */
async function probeCompletion(input: LlmProbeInput, timeoutMs: number) {
  const { endpoint, apiStyle } = normalizeLlmCompletionEndpoint(input.baseUrl);
  await assertPublicLlmEndpoint(endpoint, input.resolver);
  const body = apiStyle === "responses"
    ? { model: input.modelName, input: "Reply with OK only.", max_output_tokens: 1 }
    : { model: input.modelName, messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 1 };
  const startedAt = Date.now();
  const response = await withTimeout(timeoutMs, (signal) =>
    (input.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    }));
  if (!response.ok) throw new Error(describeHttpFailure(response.status));
  return { ok: true, latencyMs: Date.now() - startedAt, apiStyle };
}

export async function probeLlmProvider(input: LlmProbeInput): Promise<LlmProbeResult> {
  if (!input.apiKey || input.apiKey.length > 512) throw new Error("请填写有效的 API Key");
  const timeoutMs = clampTimeout(input.timeoutMs);
  const startedAt = Date.now();

  const list = await fetchModelList(input, timeoutMs);
  const completion = input.modelName ? await probeCompletion(input, timeoutMs) : null;

  // 两条都失败才算这次探测失败：拉不到列表但补全可用，是完全正常的配置。
  if (!list.models && !completion) {
    throw new Error(list.reason ?? "无法连接到该模型服务");
  }
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    models: list.models,
    modelsUnavailableReason: list.models ? null : list.reason,
    completion,
  };
}
