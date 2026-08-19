import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    if (!process.env.RESEND_WEBHOOK_SECRET?.trim()) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "Resend Webhook 签名密钥尚未配置", 503);
    }
    if (!request.headers.get("svix-signature")) {
      throw new ResearchApiError("WEBHOOK_SIGNATURE_REQUIRED", "缺少 Resend Webhook 签名", 401);
    }
    return Response.json({ received: true, queued: false }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

