import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

type ConfigurationResponse = {
  ok: boolean;
  id?: string;
  configured?: boolean;
  requiresRetest?: boolean;
  error?: { code: string; message: string; details: Record<string, unknown> };
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request, 4_096);
    if (Object.keys(body).some(key => !["mainCoinType", "tokenCoinType", "walletId", "reason"].includes(key))) {
      throw new ResearchApiError("VALIDATION_ERROR", "支付配置包含未知字段", 422);
    }
    const mainCoinType = String(body.mainCoinType ?? "").trim();
    const tokenCoinType = String(body.tokenCoinType ?? "").trim();
    const walletId = body.walletId === null || body.walletId === undefined || body.walletId === ""
      ? null : String(body.walletId).trim();
    const auditAction = "maintenance.payment_provider.configure";
    const reason = automaticAuditReason(auditAction);
    if (!/^\d{1,20}$/.test(mainCoinType) || !Number.isSafeInteger(Number(mainCoinType))) {
      throw new ResearchApiError("VALIDATION_ERROR", "主币种编号无效", 422, { fields: ["mainCoinType"] });
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(tokenCoinType)) {
      throw new ResearchApiError("VALIDATION_ERROR", "USDT 币种编号无效", 422, { fields: ["tokenCoinType"] });
    }
    if (walletId && !/^[A-Za-z0-9._:-]{1,128}$/.test(walletId)) {
      throw new ResearchApiError("VALIDATION_ERROR", "钱包编号无效", 422, { fields: ["walletId"] });
    }
    const correlation = maintenanceCorrelation(request);
    const result = await runMaintenanceIdempotentCommand<ConfigurationResponse>(await getPostgresPool(), {
      operation: "maintenance.payment_provider.configuration", actorUserId: user.id,
      subjectType: "payment_provider_config", subjectId: id,
      idempotencyKey: idempotencyKey(request),
      payload: { mainCoinType, tokenCoinType, walletId, action: reason },
      ...correlation,
    }, async client => {
      try {
        const existing = await client.query<{ provider: string; status: string; settings_json: Record<string, unknown> }>(`
          SELECT provider,status,settings_json FROM payment_provider_configs WHERE id=$1 FOR UPDATE
        `, [id]);
        const row = existing.rows[0];
        if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
        if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅支持优盾币种映射", 409);
        if (row.status !== "disabled") throw new ResearchApiError("PAYMENT_PROVIDER_MUST_BE_DISABLED", "修改币种映射前必须停用通道", 409);
        const settings = { ...row.settings_json, protocol: "legacy_md5", asset: "USDT", mainCoinType, tokenCoinType, walletId };
        await client.query(`UPDATE payment_provider_configs SET settings_json=$2::jsonb,
          last_test_at=NULL,last_test_status=NULL,last_test_configuration_version=NULL,last_error_code=NULL,
          last_callback_test_at=NULL,last_callback_test_status=NULL,last_callback_test_configuration_version=NULL,
          last_callback_error_code=NULL,updated_by_user_id=$3,updated_at=now() WHERE id=$1`,
        [id, JSON.stringify(settings), user.id]);
        await client.query(`INSERT INTO audit_logs(
          id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id,trace_id
        ) VALUES($1,$2,'payment_provider.configuration_changed','payment_provider_config',$3,$4,$5,$6,$7)`, [
          crypto.randomUUID(), user.id, id,
          JSON.stringify({
            mainCoinType: row.settings_json.mainCoinType ?? null,
            tokenCoinTypeConfigured: Boolean(row.settings_json.tokenCoinType),
            walletIdConfigured: Boolean(row.settings_json.walletId),
          }),
          JSON.stringify({
            mainCoinType, tokenCoinTypeConfigured: true, walletIdConfigured: Boolean(walletId),
            reason, auditSource: "automatic", action: auditAction,
          }),
          correlation.requestId, correlation.traceId,
        ]);
        return { terminalStatus: "succeeded", responseStatus: 200,
          response: { ok: true, id, configured: true, requiresRetest: true } } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return { terminalStatus: "failed", responseStatus: error.status, errorCode: error.code,
          response: { ok: false, error: { code: error.code, message: error.message, details: error.details } } } as const;
      }
    });
    if (result.terminalStatus !== "succeeded") {
      throw new ResearchApiError(result.errorCode ?? "PAYMENT_CONFIGURATION_FAILED",
        result.response.error?.message ?? "支付配置修改失败", result.responseStatus,
        { ...(result.response.error?.details ?? {}), replayed: result.replayed });
    }
    return Response.json(result.response, { headers: {
      "cache-control": "no-store", "idempotency-replayed": String(result.replayed),
    } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
