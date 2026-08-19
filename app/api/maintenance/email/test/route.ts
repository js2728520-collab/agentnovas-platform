import { requireAccessPermission } from "@/lib/access-control";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await requireAccessPermission(request, "maint.email_integrations.manage");
    if (!process.env.RESEND_API_KEY?.trim()) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "Resend API Key 尚未配置", 503);
    }
    return Response.json({
      ok: false,
      status: "configured_not_sent",
      message: "邮件发送测试将在 Notification Worker 接入模板后启用",
    }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

