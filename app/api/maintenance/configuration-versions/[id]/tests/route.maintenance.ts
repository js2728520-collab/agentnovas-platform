import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { testConfigurationVersion } from "@/lib/versioned-configuration-service";

const MANAGE_PERMISSION = "maint.configuration_versions.manage";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, MANAGE_PERMISSION);
    const { id } = await params;
    return Response.json(await testConfigurationVersion(await getPostgresPool(), {
      versionId: id,
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      test: await commercialJson(request, 4_096),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
