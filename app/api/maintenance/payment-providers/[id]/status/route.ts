import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { readUdunRuntimeConfig } from "@/lib/udun-payment";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    idempotencyKey(request);
    const { id } = await context.params;
    const body = await readResearchJson(request, 4_096);
    const status = String(body.status ?? "");
    if (status !== "disabled" && status !== "active") throw new ResearchApiError("VALIDATION_ERROR", "支付渠道状态无效", 422, { fields: ["status"] });
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写支付渠道变更原因", 422, { fields: ["reason"] });
    const client = await (await getPostgresPool()).connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ provider: string; status: string; settings_json: Record<string, unknown>; last_test_status: string | null; last_test_at: Date | null }>(`
        SELECT provider,status,settings_json,last_test_status,last_test_at FROM payment_provider_configs WHERE id=$1 FOR UPDATE
      `, [id]);
      const row = existing.rows[0];
      if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
      if (status === "active") {
        if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅允许启用优盾充值通道", 409);
        readUdunRuntimeConfig();
        if (!String(row.settings_json.mainCoinType ?? "").trim() || !String(row.settings_json.tokenCoinType ?? "").trim()) {
          throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "必须先配置优盾主币种和 USDT 币种编号", 503);
        }
        if (row.last_test_status !== "passed" || !row.last_test_at || Date.now() - row.last_test_at.getTime() > 24 * 60 * 60 * 1_000) {
          throw new ResearchApiError("PAYMENT_PROVIDER_TEST_REQUIRED", "启用前必须通过 24 小时内的优盾连通测试", 409);
        }
      }
      const result = await client.query(`UPDATE payment_provider_configs SET status=$1,
        encrypted_secret_ref=CASE WHEN provider='udun' AND $1='active' THEN 'env:UDUN_API_KEY' ELSE encrypted_secret_ref END,
        updated_by_user_id=$2,updated_at=now() WHERE id=$3 AND status IS DISTINCT FROM $1 RETURNING id`, [status, user.id, id]);
      if (result.rows[0]) {
        const correlation = maintenanceCorrelation(request);
        await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id)
          VALUES($1,$2,'payment_provider.status_changed','payment_provider_config',$3,$4,$5,$6)`, [
          crypto.randomUUID(), user.id, id, JSON.stringify({ status, reason }), correlation.requestId, correlation.traceId,
        ]);
      }
      await client.query("COMMIT");
      return Response.json({ ok: true, id, status, result: result.rows[0] ? "CHANGED" : "NO_CHANGE" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
