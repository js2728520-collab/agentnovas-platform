import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { getPostgresPool } from "@/lib/postgres";
import { verifyReleaseVersion } from "@/lib/release-version-service";
import { researchErrorResponse } from "@/lib/research-api";

const APPROVE_PERMISSION = "maint.releases.approve";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, APPROVE_PERMISSION);
    const { id } = await params;
    const verification = await commercialJson(request, 4_096);
    return Response.json(await verifyReleaseVersion(await getPostgresPool(), {
      releaseVersionId: id,
      reviewerUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: requestId(request),
      verification,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
