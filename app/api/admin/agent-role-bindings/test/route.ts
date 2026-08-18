import { ensureDatabaseSchema } from "@/lib/database-schema";
import { testAgentRoleConnection } from "@/lib/llm-profile-connection";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireResearchUser(request, ["hq_admin"]);
    const body = await readResearchJson(request);
    const pool = await getPostgresPool();
    return Response.json(await testAgentRoleConnection(pool, { role: String(body.role ?? "") }));
  } catch (error) {
    return researchErrorResponse(error);
  }
}
