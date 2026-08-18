import { bindAgentRole, listAgentRoleBindings, missingAgentRoles } from "@/lib/agent-model-profiles";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPostgresPool } from "@/lib/postgres";
import { requeueResearchRunsPausedForRoles } from "@/lib/postgres-research-queue";
import { readResearchJson, requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    await requireResearchUser(request, ["hq_admin"]);
    const pool = await getPostgresPool();
    return Response.json({ bindings: await listAgentRoleBindings(pool, { visibility: "administrator" }) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureD1Schema();
    const user = await requireResearchUser(request, ["hq_admin"]);
    const body = await readResearchJson(request);
    const pool = await getPostgresPool();
    const binding = await bindAgentRole(pool, {
      actorUserId: user.id,
      role: String(body.role ?? ""),
      profileId: String(body.profileId ?? ""),
      enabled: body.enabled !== false,
    });
    const missingRoles = await missingAgentRoles(pool);
    const resumedRuns = missingRoles.length === 0
      ? await requeueResearchRunsPausedForRoles(pool)
      : [];
    return Response.json({ binding, missingRoles, resumedRunCount: resumedRuns.length });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
