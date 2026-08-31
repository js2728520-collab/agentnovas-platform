import { requireAccessPermission } from "@/lib/access-control";
import { loadPaymentSecretRequest } from "@/lib/payment-secret-management";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    return Response.json(await loadPaymentSecretRequest(await getPostgresPool(), id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return researchErrorResponse(error, request); }
}
