import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { readUdunRuntimeConfig, testUdunConnectivity } from "@/lib/udun-payment";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    idempotencyKey(request);
    const { id } = await context.params;
    await readResearchJson(request, 4_096);
    if (process.env.PAYMENT_PROVIDER_TESTS_ENABLED !== "true") {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付服务商连通测试尚未启用", 503, { providerConfigId: id });
    }
    const pool = await getPostgresPool();
    const provider = await pool.query<{ provider: string }>("SELECT provider FROM payment_provider_configs WHERE id=$1 LIMIT 1", [id]);
    if (!provider.rows[0]) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    if (provider.rows[0].provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅实现优盾连通测试", 409);
    try {
      await testUdunConnectivity({ config: readUdunRuntimeConfig() });
      await pool.query(`UPDATE payment_provider_configs SET last_test_at=now(),last_test_status='passed',last_error_code=NULL,updated_at=now() WHERE id=$1`, [id]);
    } catch (error) {
      const code = error instanceof ResearchApiError ? error.code : "UDUN_CONNECTIVITY_FAILED";
      await pool.query(`UPDATE payment_provider_configs SET last_test_at=now(),last_test_status='failed',last_error_code=$2,updated_at=now() WHERE id=$1`, [id, code]);
      throw new ResearchApiError("PAYMENT_PROVIDER_UNAVAILABLE", "优盾连通测试失败", 503, { providerConfigId: id });
    }
    await recordMaintenanceAudit(pool, {
      actorUserId: user.id, action: "maintenance.payment_test_passed", subjectType: "payment_provider_config",
      subjectId: id, ...maintenanceCorrelation(request),
    });
    return Response.json({ ok: true, status: "passed", providerConfigId: id, testedAt: new Date().toISOString() });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
