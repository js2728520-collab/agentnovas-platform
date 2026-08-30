import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireAccessPermission } from "@/lib/access-control";
import { probeCompatibilityRole } from "@/lib/ai-control-plane-compatibility";
import { getPostgresPool } from "@/lib/postgres";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import {
  readResearchJson,
  researchErrorResponse,
} from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request, "maint.agent_bindings.manage");
    const body = await readResearchJson(request);
    const reason = automaticAuditReason("ai_control_plane.legacy_runtime_binding.probe");
    const role = String(body.role ?? "");
    const pool = await getPostgresPool();
    return Response.json(await probeCompatibilityRole(pool, {
      role,actorUserId: user.id,reason,
      requestId: maintenanceCorrelation(request).requestId ?? crypto.randomUUID(),signal: request.signal,
    }));
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
