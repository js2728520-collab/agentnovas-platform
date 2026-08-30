import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    idempotencyKey(request);
    const { id } = await context.params;
    const body = await readResearchJson(request, 4_096);
    const mainCoinType = String(body.mainCoinType ?? "").trim();
    const tokenCoinType = String(body.tokenCoinType ?? "").trim();
    const walletId = body.walletId === null || body.walletId === undefined || body.walletId === "" ? null : String(body.walletId).trim();
    const reason = automaticAuditReason("maintenance.payment_provider.configure");
    if (!/^\d{1,20}$/.test(mainCoinType)) throw new ResearchApiError("VALIDATION_ERROR", "主币种编号无效", 422, { fields: ["mainCoinType"] });
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(tokenCoinType)) throw new ResearchApiError("VALIDATION_ERROR", "USDT 币种编号无效", 422, { fields: ["tokenCoinType"] });
    if (walletId && !/^[A-Za-z0-9._:-]{1,128}$/.test(walletId)) throw new ResearchApiError("VALIDATION_ERROR", "钱包编号无效", 422, { fields: ["walletId"] });
    const client = await (await getPostgresPool()).connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ provider: string; status: string; settings_json: Record<string, unknown> }>(`
        SELECT provider,status,settings_json FROM payment_provider_configs WHERE id=$1 FOR UPDATE
      `, [id]);
      const row = existing.rows[0];
      if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
      if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅支持优盾币种映射", 409);
      if (row.status !== "disabled") throw new ResearchApiError("PAYMENT_PROVIDER_MUST_BE_DISABLED", "修改币种映射前必须停用通道", 409);
      const settings = { ...row.settings_json, protocol: "legacy_md5", asset: "USDT", mainCoinType, tokenCoinType, walletId };
      await client.query(`UPDATE payment_provider_configs SET settings_json=$2::jsonb,last_test_status=NULL,
        last_error_code=NULL,updated_by_user_id=$3,updated_at=now() WHERE id=$1`, [id, JSON.stringify(settings), user.id]);
      const correlation = maintenanceCorrelation(request);
      await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id,trace_id)
        VALUES($1,$2,'payment_provider.configuration_changed','payment_provider_config',$3,$4,$5,$6,$7)`, [
        crypto.randomUUID(), user.id, id,
        JSON.stringify({ mainCoinType: row.settings_json.mainCoinType ?? null, tokenCoinTypeConfigured: Boolean(row.settings_json.tokenCoinType), walletIdConfigured: Boolean(row.settings_json.walletId) }),
        JSON.stringify({ mainCoinType, tokenCoinTypeConfigured: true, walletIdConfigured: Boolean(walletId), reason, auditSource: "automatic" }),
        correlation.requestId, correlation.traceId,
      ]);
      await client.query("COMMIT");
      return Response.json({ ok: true, id, configured: true, requiresRetest: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
