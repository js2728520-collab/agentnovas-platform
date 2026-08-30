import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, commercialListInput, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { createReleaseVersion, readReleaseManagement } from "@/lib/release-version-service";
import { researchErrorResponse } from "@/lib/research-api";

const VIEW_PERMISSION = "maint.releases.view";
const MANAGE_PERMISSION = "maint.releases.manage";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    const input = commercialListInput(request);
    return Response.json(await readReleaseManagement(await getPostgresPool(), input), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, MANAGE_PERMISSION);
    const release = {
      ...await commercialJson(request, 16_384),
      reason: automaticAuditReason("maintenance.release.register"),
    };
    const result = await createReleaseVersion(await getPostgresPool(), {
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      release,
    });
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
