import { requireAccessPermission } from "@/lib/access-control";
import { decideAttributionChange } from "@/lib/attribution-change-service";
import { operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.attributions.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 2_048);
    const decision = typeof body.decision === "string" ? body.decision : "";
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("ATTRIBUTION_DECISION_INVALID", "客户归属复核决定无效", 422);
    return Response.json(await decideAttributionChange(await getPostgresPool(), {
      actorUserId: user.id, changeId: id, decision,
      note: typeof body.note === "string" ? body.note : "",
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      authorize: operationsCustomerScopeAuthorization(scope, { userId: user.id, organizationId: user.organizationId }, organizationIds),
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
