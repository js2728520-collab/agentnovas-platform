import { requireAccessPermission } from "@/lib/access-control";
import { loadPaymentSecretManagementStatus } from "@/lib/payment-secret-management";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.payment_integrations.manage");
    return Response.json(await loadPaymentSecretManagementStatus(await getPostgresPool()), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return researchErrorResponse(error, request); }
}
