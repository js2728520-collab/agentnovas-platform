import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const STOP_PERMISSION = "maint.releases.workflow.stop";

export async function POST(request: Request) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, STOP_PERMISSION);
    const body = await commercialJson(request);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "stop.request",
      parameters: { environment: typeof body.environment === "string" ? body.environment : "" }, actorUserId: user.id, idempotencyKey: idempotencyKey(request),
      sessionSecret,
      requestId: requestId(request), body: { reason: body.reason },
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
