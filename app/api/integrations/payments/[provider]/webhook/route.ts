import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    throw new ResearchApiError("PAYMENT_WEBHOOK_DISABLED", "支付 Webhook 验签适配器尚未接入", 503);
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
