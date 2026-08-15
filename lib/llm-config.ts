import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { llmConfigurations } from "@/db/schema";
import { decryptIntegrationSecret, encryptIntegrationSecret, maskedIntegrationSecret } from "@/lib/integration-credentials";

export type LlmConfigInput = {
  providerName?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
};

export type ResolvedLlmConfig = {
  providerName: string;
  endpoint: string;
  apiStyle: "chat_completions" | "responses";
  model: string;
  apiKey: string;
  source: "user" | "system" | "environment";
};

export function publicLlmConfig(row: typeof llmConfigurations.$inferSelect | undefined) {
  if (!row) return null;
  return {
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    model: row.model,
    maskedApiKey: row.maskedApiKey,
    hasApiKey: Boolean(row.encryptedApiKey),
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

function privateNetworkHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (!ipv4 || ipv4.some(part => part > 255)) return false;
  const [a, b] = ipv4;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function normalizeEndpoint(value: unknown) {
  const input = String(value ?? "").trim().replace(/\/+$/, "");
  if (!input || input.length > 2048) throw new Error("请填写有效的接口地址");
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error("接口地址格式不正确"); }
  if (parsed.protocol !== "https:") throw new Error("接口地址必须使用 HTTPS");
  if (parsed.username || parsed.password) throw new Error("接口地址不能包含账号或密码");
  if (parsed.search || parsed.hash) throw new Error("接口地址不能包含查询参数或锚点");
  if (privateNetworkHost(parsed.hostname)) throw new Error("接口地址不能指向本机或内网地址");
  return input;
}

export function normalizeLlmCompletionEndpoint(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) return { endpoint: normalized, apiStyle: "responses" as const };
  if (/\/chat\/completions$/i.test(normalized)) return { endpoint: normalized, apiStyle: "chat_completions" as const };
  return { endpoint: `${normalized}/chat/completions`, apiStyle: "chat_completions" as const };
}

export async function resolveLlmConfig(userId: string): Promise<ResolvedLlmConfig | null> {
  const db = getDb();
  const userConfig = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, `user-${userId}`) });
  const systemConfig = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, "system-default") });
  const stored = userConfig?.enabled && userConfig.encryptedApiKey
    ? { row: userConfig, source: "user" as const }
    : systemConfig?.enabled && systemConfig.encryptedApiKey
      ? { row: systemConfig, source: "system" as const }
      : null;

  if (stored) {
    const target = normalizeLlmCompletionEndpoint(stored.row.baseUrl);
    return {
      providerName: stored.row.providerName,
      endpoint: target.endpoint,
      apiStyle: target.apiStyle,
      model: stored.row.model,
      apiKey: await decryptIntegrationSecret(stored.row.encryptedApiKey),
      source: stored.source,
    };
  }

  const baseUrl = process.env.AI_API_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const target = normalizeLlmCompletionEndpoint(baseUrl);
  return { providerName: "Environment default", endpoint: target.endpoint, apiStyle: target.apiStyle, model, apiKey, source: "environment" };
}

export async function saveLlmConfig(options: {
  id: string;
  scope: "system" | "user";
  ownerUserId: string | null;
  updatedByUserId: string;
  input: LlmConfigInput;
}) {
  const db = getDb();
  const existing = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, options.id) });
  const providerName = String(options.input.providerName ?? "").trim().slice(0, 60) || "OpenAI Compatible";
  const baseUrl = normalizeEndpoint(options.input.baseUrl);
  const model = String(options.input.model ?? "").trim().slice(0, 100);
  if (!model) throw new Error("请填写模型名称");
  const apiKey = String(options.input.apiKey ?? "").trim();
  if (!existing?.encryptedApiKey && !apiKey) throw new Error("首次配置必须填写 API Key");
  const encryptedApiKey = apiKey ? await encryptIntegrationSecret(apiKey) : existing?.encryptedApiKey ?? "";
  const maskedApiKey = apiKey ? maskedIntegrationSecret(apiKey) : existing?.maskedApiKey ?? "";
  const now = new Date().toISOString();

  await db.insert(llmConfigurations).values({
    id: options.id,
    scope: options.scope,
    ownerUserId: options.ownerUserId,
    providerName,
    baseUrl,
    model,
    encryptedApiKey,
    maskedApiKey,
    enabled: options.input.enabled !== false,
    updatedByUserId: options.updatedByUserId,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: llmConfigurations.id,
    set: { providerName, baseUrl, model, encryptedApiKey, maskedApiKey, enabled: options.input.enabled !== false, updatedByUserId: options.updatedByUserId, updatedAt: now },
  });

  return db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, options.id) });
}

export async function testLlmConfig(options: { id: string; input: LlmConfigInput }) {
  const db = getDb();
  const existing = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, options.id) });
  const baseUrl = String(options.input.baseUrl ?? existing?.baseUrl ?? "").trim();
  const model = String(options.input.model ?? existing?.model ?? "").trim();
  const suppliedApiKey = String(options.input.apiKey ?? "").trim();
  const apiKey = suppliedApiKey || (existing?.encryptedApiKey ? await decryptIntegrationSecret(existing.encryptedApiKey) : "");
  if (!baseUrl) throw new Error("请填写接口地址");
  if (!model) throw new Error("请填写模型名称");
  if (!apiKey) throw new Error("请填写 API Key");

  const target = normalizeLlmCompletionEndpoint(normalizeEndpoint(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const startedAt = Date.now();
  try {
    const body = target.apiStyle === "responses"
      ? { model, input: "Reply with OK only.", max_output_tokens: 1 }
      : { model, messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 1 };
    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403
        ? "API Key 无效或没有权限"
        : response.status === 404
          ? "接口路径不存在"
          : `服务商返回 HTTP ${response.status}`;
      throw new Error(reason);
    }
    return { ok: true, status: response.status, latencyMs: Date.now() - startedAt, apiStyle: target.apiStyle };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("连接超时（12 秒）");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
