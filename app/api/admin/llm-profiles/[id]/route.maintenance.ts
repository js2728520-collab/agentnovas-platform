import { missingAgentRoles, saveLlmProfile, snapshotAgentRoleBindings, type LlmProfileInput } from "@/lib/agent-model-profiles";
import { requireAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { maintenanceLlmProfileView } from "@/lib/maintenance-model-view";
import { requeueResearchRunsPausedForRoles } from "@/lib/postgres-research-queue";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const input = body as LlmProfileInput;
    const { id } = await params;
    const pool = await getPostgresPool();
    const profile = await saveLlmProfile(pool, { id, actorUserId: user.id, input });
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.llm_profile_updated", subjectType: "llm_profile", subjectId: profile.id, reason });
    const missingRoles = await missingAgentRoles(pool);
    const snapshot = missingRoles.length === 0 ? await snapshotAgentRoleBindings(pool) : null;
    const resumedRuns = snapshot
      ? await requeueResearchRunsPausedForRoles(pool, snapshot.roles)
      : [];
    return Response.json({ profile: maintenanceLlmProfileView(profile), missingRoles, resumedRunCount: resumedRuns.length });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
