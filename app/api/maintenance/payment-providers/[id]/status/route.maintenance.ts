import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { loadPaymentSecretManagementStatus } from "@/lib/payment-secret-management";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { paymentActivationGate } from "@/packages/payments/src/udun-service-management";

type StatusResponse = {
  ok: boolean;
  id?: string;
  status?: string;
  result?: "CHANGED" | "NO_CHANGE";
  error?: { code: string; message: string; details: Record<string, unknown> };
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request, 4_096);
    const status = String(body.status ?? "");
    if (status !== "disabled" && status !== "active") throw new ResearchApiError("VALIDATION_ERROR", "支付渠道状态无效", 422, { fields: ["status"] });
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (reason.length < 3) throw new ResearchApiError("VALIDATION_ERROR", "必须填写至少 3 个字符的支付渠道变更原因", 422, { fields: ["reason"] });
    const correlation = maintenanceCorrelation(request);
    const result = await runMaintenanceIdempotentCommand<StatusResponse>(await getPostgresPool(), {
      operation: "maintenance.payment_provider.status", actorUserId: user.id,
      subjectType: "payment_provider_config", subjectId: id,
      idempotencyKey: idempotencyKey(request), payload: { status, reason }, ...correlation,
    }, async client => {
      try {
        const existing = await client.query<{
          provider: string; status: string; settings_json: Record<string, unknown>;
          secret_configuration_version: string | null; last_test_status: string | null; last_test_at: Date | null;
          last_test_configuration_version: string | null; last_callback_test_status: string | null;
          last_callback_test_at: Date | null; last_callback_test_configuration_version: string | null;
        }>(`
          SELECT provider,status,settings_json,secret_configuration_version,
            last_test_status,last_test_at,last_test_configuration_version,
            last_callback_test_status,last_callback_test_at,last_callback_test_configuration_version
          FROM payment_provider_configs WHERE id=$1 FOR UPDATE
        `, [id]);
        const row = existing.rows[0];
        if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
        if (status === "active") {
          if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅允许启用优盾充值通道", 409);
          let secretConfigured = false;
          try {
            const runtime = await resolveUdunRuntimeConfig("maintenance");
            secretConfigured = Boolean(runtime.managedConfigurationVersion
              && runtime.managedConfigurationVersion === row.secret_configuration_version);
          } catch { secretConfigured = false; }
          const broker = await loadPaymentSecretManagementStatus(client);
          const activation = paymentActivationGate({
            secretConfigured, brokerAvailable: broker.broker.available,
            coinMappingConfigured: Boolean(String(row.settings_json.mainCoinType ?? "").trim()
              && String(row.settings_json.tokenCoinType ?? "").trim()),
            providerAuthorized: process.env.PAYMENT_PROVIDER_OUTBOUND_ENABLED === "true",
            configurationVersion: row.secret_configuration_version,
            providerTest: { status: row.last_test_status, at: row.last_test_at?.toISOString() ?? null,
              configurationVersion: row.last_test_configuration_version },
            callbackTest: { status: row.last_callback_test_status, at: row.last_callback_test_at?.toISOString() ?? null,
              configurationVersion: row.last_callback_test_configuration_version },
          });
          if (!activation.ready) throw new ResearchApiError(
            "PAYMENT_ACTIVATION_GATES_FAILED", "启用前必须完成商户配置、Provider 与公网回调测试及外发授权", 409,
            { blockers: activation.blockers },
          );
        }
        const changed = await client.query(`UPDATE payment_provider_configs SET status=$1,
          encrypted_secret_ref=CASE WHEN provider='udun' AND $1='active' THEN 'managed:payment-secret-broker' ELSE encrypted_secret_ref END,
          updated_by_user_id=$2,updated_at=now() WHERE id=$3 AND status IS DISTINCT FROM $1 RETURNING id`, [status, user.id, id]);
        if (changed.rows[0]) {
          await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id)
            VALUES($1,$2,'payment_provider.status_changed','payment_provider_config',$3,$4,$5,$6)`, [
            crypto.randomUUID(), user.id, id, JSON.stringify({ status, reason }), correlation.requestId, correlation.traceId,
          ]);
        }
        return { terminalStatus: "succeeded", responseStatus: 200,
          response: { ok: true, id, status, result: changed.rows[0] ? "CHANGED" : "NO_CHANGE" } } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return { terminalStatus: "failed", responseStatus: error.status, errorCode: error.code,
          response: { ok: false, error: { code: error.code, message: error.message, details: error.details } } } as const;
      }
    });
    if (result.terminalStatus !== "succeeded") {
      throw new ResearchApiError(result.errorCode ?? "PAYMENT_STATUS_CHANGE_FAILED",
        result.response.error?.message ?? "支付渠道状态修改失败", result.responseStatus,
        { ...(result.response.error?.details ?? {}), replayed: result.replayed });
    }
    return Response.json(result.response, { headers: {
      "cache-control": "no-store", "idempotency-replayed": String(result.replayed),
    } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
