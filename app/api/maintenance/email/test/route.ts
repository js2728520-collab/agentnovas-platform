import { requireAccessPermission } from "@/lib/access-control";
import { maintenanceCorrelation, maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    if (!process.env.RESEND_API_KEY?.trim()) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "Resend API Key 尚未配置", 503);
    }
    const pool = await getPostgresPool();
    const testedAt = new Date().toISOString();
    await pool.query(`
      UPDATE notification_provider_configs
      SET last_test_at = $1, updated_at = now()
      WHERE provider = 'resend'
    `, [testedAt]);
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.email_test_recorded", subjectType: "notification_provider", subjectId: "resend", reason, ...maintenanceCorrelation(request) });
    return Response.json({
      ok: false,
      status: "configured_not_sent",
      message: "邮件发送测试将在 Notification Worker 接入模板后启用",
      testedAt,
    }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
