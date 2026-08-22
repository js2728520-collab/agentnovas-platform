import { requireAccessPermission } from "@/lib/access-control";
import { operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { changeOperationsCustomerStatus } from "@/lib/operations-customer-service";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 2_048);
    const action = typeof body.action === "string" ? body.action : "";
    if (!(["freeze", "restore", "archive"] as const).includes(action as "freeze" | "restore" | "archive")) throw new ResearchApiError("CUSTOMER_ACTION_INVALID", "客户操作无效", 422);
    return Response.json(await changeOperationsCustomerStatus(await getPostgresPool(), {
      actorUserId: user.id,
      customerId: id,
      action: action as "freeze" | "restore" | "archive",
      reason: typeof body.reason === "string" ? body.reason : "",
      authorize: operationsCustomerScopeAuthorization(scope, { userId: user.id, organizationId: user.organizationId }, organizationIds),
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
