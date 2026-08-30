import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const STOP_RELEASE_PERMISSION = "maint.releases.workflow.stop.release";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, STOP_RELEASE_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "stop_release.review",
      parameters: { stopReleaseRequestId: (await context.params).id }, actorUserId: user.id, idempotencyKey: idempotencyKey(request),
      sessionSecret,
      requestId: requestId(request), body: { ...await commercialJson(request), reason: automaticAuditReason("maintenance.release_workflow.stop_release.review") },
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
