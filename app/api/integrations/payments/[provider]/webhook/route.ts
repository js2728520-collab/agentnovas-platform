import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await context.params;
    const secret = process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    if (!secret) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付 Webhook 签名密钥尚未配置", 503);
    if (!request.headers.get("x-webhook-signature")) throw new ResearchApiError("WEBHOOK_SIGNATURE_REQUIRED", "缺少 Webhook 签名", 401);
    return Response.json({ received: true, queued: false, provider }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
