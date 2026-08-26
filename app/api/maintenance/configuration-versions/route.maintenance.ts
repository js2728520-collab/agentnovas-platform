import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, commercialListInput, idempotencyKey, requestId } from "@/lib/commercial-api";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { createConfigurationVersion, readConfigurationVersions } from "@/lib/versioned-configuration-service";

const VIEW_PERMISSION = "maint.configuration_versions.view";
const MANAGE_PERMISSION = "maint.configuration_versions.manage";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    return Response.json(await readConfigurationVersions(await getPostgresPool(), commercialListInput(request)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, MANAGE_PERMISSION);
    const version = await commercialJson(request, 70_000);
    return Response.json(await createConfigurationVersion(await getPostgresPool(), {
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      version,
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
