import { saveLlmProfile, type LlmProfileInput } from "@/lib/agent-model-profiles";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const user = await requireResearchUser(request, ["hq_admin"]);
    const input = await readResearchJson(request) as LlmProfileInput;
    const { id } = await params;
    const pool = await getPostgresPool();
    const profile = await saveLlmProfile(pool, { id, actorUserId: user.id, input });
    return Response.json({ profile });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
