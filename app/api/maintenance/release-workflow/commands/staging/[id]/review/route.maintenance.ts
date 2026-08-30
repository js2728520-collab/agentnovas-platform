import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const STAGE_PERMISSION = "maint.releases.workflow.stage";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, STAGE_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "command.review",
      parameters: { commandRequestId: (await context.params).id, environment: "staging" }, actorUserId: user.id, idempotencyKey: idempotencyKey(request),
      sessionSecret,
      requestId: requestId(request), body: { ...await commercialJson(request), reason: automaticAuditReason("maintenance.release_workflow.command.review") },
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
