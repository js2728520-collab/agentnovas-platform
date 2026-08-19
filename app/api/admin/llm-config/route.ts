import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { llmConfigurations } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { publicLlmConfig, saveLlmConfig, type LlmConfigInput } from "@/lib/llm-config";
import { requireUser, responseError } from "@/lib/session";

const CONFIG_ID = "system-default";

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    await requireUser(request, ["hq_admin", "maintenance_admin"]);
    const db = getDb();
    const config = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, CONFIG_ID) });
    return Response.json({ config: publicLlmConfig(config) });
  } catch (error) { return responseError(error); }
}

export async function PUT(request: Request) {
  try {
    await ensureD1Schema();
    const user = await requireUser(request, ["hq_admin", "maintenance_admin"]);
    const input = await request.json() as LlmConfigInput;
    const config = await saveLlmConfig({ id: CONFIG_ID, scope: "system", ownerUserId: null, updatedByUserId: user.id, input });
    return Response.json({ ok: true, config: publicLlmConfig(config) });
  } catch (error) { return responseError(error); }
}
