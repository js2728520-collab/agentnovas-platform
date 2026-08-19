import { requireAccessPermission } from "@/lib/access-control";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    if (!process.env.PAYMENT_PROVIDER_TESTS_ENABLED) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付服务商连通测试尚未启用", 503, { providerConfigId: id });
    }
    return Response.json({ ok: false, status: "configured_not_called", providerConfigId: id }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
