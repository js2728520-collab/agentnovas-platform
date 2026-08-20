import { listLlmProfiles, saveLlmProfile, type LlmProfileInput } from "@/lib/agent-model-profiles";
import { requireAccessPermission, requireAnyAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { maintenanceLlmProfileView } from "@/lib/maintenance-model-view";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.llm_profiles.manage"]);
    const pool = await getPostgresPool();
    const profiles = await listLlmProfiles(pool);
    return Response.json({ profiles: profiles.map(maintenanceLlmProfileView) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const input = body as LlmProfileInput;
    const pool = await getPostgresPool();
    const profile = await saveLlmProfile(pool, { actorUserId: user.id, input });
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.llm_profile_created", subjectType: "llm_profile", subjectId: profile.id, reason });
    return Response.json({ profile: maintenanceLlmProfileView(profile) }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
