import {
  bindRuntimeExplanationRole,
  listRuntimeExplanationBindings,
} from "@/lib/agent-model-profiles";
import { requireAccessPermission, requireAnyAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import {
  readResearchJson,
  researchErrorResponse,
} from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.agent_bindings.manage"]);
    const pool = await getPostgresPool();
    const bindings = await listRuntimeExplanationBindings(pool, { visibility: "administrator" });
    return Response.json({
      bindings: bindings.map((binding) => ({
        role: binding.role, profileId: binding.profileId, profileName: binding.profileName,
        modelName: binding.modelName, configured: binding.configured, enabled: binding.enabled,
        revisionNumber: binding.revisionNumber, updatedAt: binding.updatedAt,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.agent_bindings.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const pool = await getPostgresPool();
    const binding = await bindRuntimeExplanationRole(pool, {
      actorUserId: user.id,
      role: String(body.role ?? ""),
      profileId: String(body.profileId ?? ""),
      enabled: body.enabled !== false,
    });
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.runtime_binding_changed", subjectType: "runtime_explanation_role", subjectId: String(body.role ?? ""), reason });
    return Response.json({ binding });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
