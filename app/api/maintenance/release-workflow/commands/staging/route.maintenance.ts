import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const STAGE_PERMISSION = "maint.releases.workflow.stage";

export async function POST(request: Request) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, STAGE_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "command.request",
      parameters: { releaseVersionId: new URL(request.url).searchParams.get("releaseVersionId") ?? "", environment: "staging" },
      actorUserId: user.id, sessionSecret, idempotencyKey: idempotencyKey(request),
      requestId: requestId(request), body: await commercialJson(request, 16_384),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
