import { eq } from "drizzle-orm";

import { requireAccessPermission } from "@/lib/access-control";
import { getDb } from "@/db";
import { llmConfigurations } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { publicLlmConfig, saveLlmConfig, type LlmConfigInput } from "@/lib/llm-config";
import { researchErrorResponse } from "@/lib/research-api";

const CONFIG_ID = "system-default";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAccessPermission(request, "maint.system_health.view");
    const db = getDb();
    const config = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, CONFIG_ID) });
    const value = publicLlmConfig(config);
    return Response.json({ config: value ? { providerName: value.providerName, model: value.model, hasSecret: value.hasApiKey, enabled: value.enabled, updatedAt: value.updatedAt } : null });
  } catch (error) { return researchErrorResponse(error, request); }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const input = await request.json() as LlmConfigInput;
    const config = await saveLlmConfig({ id: CONFIG_ID, scope: "system", ownerUserId: null, updatedByUserId: user.id, input });
    const value = publicLlmConfig(config);
    return Response.json({ ok: true, config: { providerName: value?.providerName, model: value?.model, hasSecret: value?.hasApiKey, enabled: value?.enabled, updatedAt: value?.updatedAt } });
  } catch (error) { return researchErrorResponse(error, request); }
}
