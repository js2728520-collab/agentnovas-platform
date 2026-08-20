import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireAccessPermission } from "@/lib/access-control";
import { testRuntimeExplanationRoleConnection } from "@/lib/llm-profile-connection";
import { getPostgresPool } from "@/lib/postgres";
import { maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import {
  readResearchJson,
  researchErrorResponse,
} from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.agent_bindings.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const role = String(body.role ?? "");
    const pool = await getPostgresPool();
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.runtime_binding_test_requested", subjectType: "runtime_explanation_role", subjectId: role, reason });
    return Response.json(await testRuntimeExplanationRoleConnection(pool, {
      role,
    }));
  } catch (error) {
    return researchErrorResponse(error);
  }
}
