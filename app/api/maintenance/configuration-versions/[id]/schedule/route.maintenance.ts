import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { scheduleConfigurationVersion } from "@/lib/versioned-configuration-service";

const APPROVE_PERMISSION = "maint.configuration_versions.approve";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, APPROVE_PERMISSION);
    const { id } = await params;
    return Response.json(await scheduleConfigurationVersion(await getPostgresPool(), {
      versionId: id,
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      schedule: {
        ...await commercialJson(request, 4_096),
        reason: automaticAuditReason("maintenance.configuration.schedule"),
      },
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
