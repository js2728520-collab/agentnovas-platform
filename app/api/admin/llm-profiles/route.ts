import { listLlmProfiles, saveLlmProfile, type LlmProfileInput } from "@/lib/agent-model-profiles";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireResearchUser(request, ["hq_admin"]);
    const pool = await getPostgresPool();
    return Response.json({ profiles: await listLlmProfiles(pool) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["hq_admin"]);
    const input = await readResearchJson(request) as LlmProfileInput;
    const pool = await getPostgresPool();
    const profile = await saveLlmProfile(pool, { actorUserId: user.id, input });
    return Response.json({ profile }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
