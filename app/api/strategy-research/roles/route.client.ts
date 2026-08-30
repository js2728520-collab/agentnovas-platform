import { listAgentRoleBindings, missingAgentRoles } from "@/lib/ai-control-plane-compatibility";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireResearchUser(request, ["customer"]);
    const pool = await getPostgresPool();
    const [roles, missingRoles] = await Promise.all([
      listAgentRoleBindings(pool, { visibility: "customer" }),
      missingAgentRoles(pool),
    ]);
    return Response.json({ roles, ready: missingRoles.length === 0, missingRoles }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
