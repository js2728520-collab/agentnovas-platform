import { requireAccessPermission } from "@/lib/access-control";
import { maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    if (process.env.PAYMENT_PROVIDER_TESTS_ENABLED !== "true") {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付服务商连通测试尚未启用", 503, { providerConfigId: id });
    }
    const pool = await getPostgresPool();
    const provider = await pool.query<{ id: string; status: string; encrypted_secret_ref: string | null }>("SELECT id, status, encrypted_secret_ref FROM payment_provider_configs WHERE id = $1 LIMIT 1", [id]);
    if (!provider.rows[0]) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    if (provider.rows[0].status === "disabled" || !provider.rows[0].encrypted_secret_ref) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付渠道未启用或密钥未配置", 503, { providerConfigId: id });
    }
    await recordMaintenanceAudit(pool, { actorUserId: user.id, action: "maintenance.payment_test_recorded", subjectType: "payment_provider_config", subjectId: id, reason });
    return Response.json({ ok: false, status: "configured_not_called", providerConfigId: id }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
