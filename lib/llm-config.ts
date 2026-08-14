import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { llmConfigurations } from "@/db/schema";
import { encryptIntegrationSecret, maskedIntegrationSecret } from "@/lib/integration-credentials";

export type LlmConfigInput = {
  providerName?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
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

function normalizeEndpoint(value: unknown) {
  const input = String(value ?? "").trim().replace(/\/+$/, "");
  const parsed = new URL(input);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) throw new Error("接口地址必须使用 HTTPS");
  return input;
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
