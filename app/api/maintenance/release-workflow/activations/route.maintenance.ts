import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const ACTIVATION_REQUEST_PERMISSION = "maint.releases.workflow.activation.request";

export async function POST(request: Request) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, ACTIVATION_REQUEST_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "activation.request",
      actorUserId: user.id, idempotencyKey: idempotencyKey(request), requestId: requestId(request),
      sessionSecret,
      body: await commercialJson(request, 16_384),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
