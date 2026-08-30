import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey, requestId } from "@/lib/commercial-api";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { invokeRestrictedCicdControlGateway } from "@/lib/restricted-cicd-control-gateway-client";
import { researchErrorResponse } from "@/lib/research-api";

const PRODUCTION_ENABLE_PERMISSION = "maint.releases.workflow.production.enable";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, sessionSecret } = await requireAccessPermission(request, PRODUCTION_ENABLE_PERMISSION);
    return Response.json(await invokeRestrictedCicdControlGateway({ request, operation: "production.enable",
      parameters: { activationId: (await context.params).id }, actorUserId: user.id, idempotencyKey: idempotencyKey(request),
      sessionSecret,
      requestId: requestId(request), body: { ...await commercialJson(request), reason: automaticAuditReason("maintenance.release_workflow.production.enable") },
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
