import {
  bindRuntimeExplanationRole,
  listRuntimeExplanationBindings,
} from "@/lib/ai-control-plane-compatibility";
import { requireAccessPermission, requireAnyAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
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
    return researchErrorResponse(error, request);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.agent_bindings.manage");
    const body = await readResearchJson(request);
    const reason = automaticAuditReason("ai_control_plane.legacy_runtime_binding.update");
    const pool = await getPostgresPool();
    const binding = await bindRuntimeExplanationRole(pool, {
      actorUserId: user.id,
      role: String(body.role ?? ""),
      profileId: String(body.profileId ?? ""),
      enabled: body.enabled !== false,
      reason,
      requestId: maintenanceCorrelation(request).requestId ?? crypto.randomUUID(),
    });
    return Response.json({ binding });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
