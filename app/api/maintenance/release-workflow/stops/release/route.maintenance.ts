import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const STOP_RELEASE_PERMISSION = "maint.releases.workflow.stop.release";

export async function POST(request: Request) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, STOP_RELEASE_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "stop_release.request",
      actorUserId: user.id, idempotencyKey: idempotencyKey(request), requestId: requestId(request),
      sessionSecret,
      body: await commercialJson(request),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
