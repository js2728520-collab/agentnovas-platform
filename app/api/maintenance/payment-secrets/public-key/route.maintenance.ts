import { requireAccessPermission } from "@/lib/access-control";
import { paymentSecretBrokerPublicConfiguration } from "@/lib/payment-secret-management";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.payment_integrations.manage");
    const configuration = await paymentSecretBrokerPublicConfiguration();
    if (!configuration) throw new ResearchApiError("PAYMENT_SECRET_BROKER_NOT_CONFIGURED", "支付密钥 Broker 尚未配置", 503);
    return Response.json(configuration, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
