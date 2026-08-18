import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { llmConfigurations } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { publicLlmConfig, saveLlmConfig, type LlmConfigInput } from "@/lib/llm-config";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
    const db = getDb();
    const config = await db.query.llmConfigurations.findFirst({ where: eq(llmConfigurations.id, `user-${user.id}`) });
    return Response.json({ config: publicLlmConfig(config) });
  } catch (error) { return responseError(error); }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
    const input = await request.json() as LlmConfigInput;
    const config = await saveLlmConfig({ id: `user-${user.id}`, scope: "user", ownerUserId: user.id, updatedByUserId: user.id, input });
    return Response.json({ ok: true, config: publicLlmConfig(config) });
  } catch (error) { return responseError(error); }
}
