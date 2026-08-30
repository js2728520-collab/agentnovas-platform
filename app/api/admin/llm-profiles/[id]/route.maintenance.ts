import {
  missingAgentRoles,
  saveCompatibilityLlmProfile,
  snapshotAgentRoleBindings,
  type CompatibilityLlmProfileInput,
} from "@/lib/ai-control-plane-compatibility";
import { requireAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { maintenanceCorrelation, maintenanceReason } from "@/lib/maintenance-audit";
import { maintenanceLlmProfileView } from "@/lib/maintenance-model-view";
import { requeueResearchRunsPausedForRoles } from "@/lib/postgres-research-queue";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const input = body as CompatibilityLlmProfileInput;
    const { id } = await params;
    const pool = await getPostgresPool();
    const profile = await saveCompatibilityLlmProfile(pool, {
      id,actorUserId: user.id,profile: input,reason,
      requestId: maintenanceCorrelation(request).requestId ?? crypto.randomUUID(),
    });
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
