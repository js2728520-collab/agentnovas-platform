import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { activateConfigurationVersion } from "@/lib/versioned-configuration-service";

const ACTIVATE_PERMISSION = "maint.configuration_versions.activate";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, ACTIVATE_PERMISSION);
    const { id } = await params;
    return Response.json(await activateConfigurationVersion(await getPostgresPool(), {
      versionId: id,
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      activation: {
        ...await commercialJson(request, 4_096),
        reason: automaticAuditReason("maintenance.configuration.activate"),
      },
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
