import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation, maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentExternalCommand } from "@/lib/maintenance-idempotency";
import { recordPaymentProviderTestRun } from "@/lib/payment-provider-test-management";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { probeUdunCallbackReadiness } from "@/lib/udun-payment";

function allowedCallbackHosts() {
  return (process.env.PAYMENT_ALLOWED_CALLBACK_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

type TestResponse = {
  ok: boolean;
  status: "passed" | "failed";
  providerConfigId: string;
  configurationVersion: string;
  testedAt: string;
  errorCode: string | null;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const reason = maintenanceReason((await readResearchJson(request, 4_096)).reason);
    if (process.env.PAYMENT_PROVIDER_TESTS_ENABLED !== "true") {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付服务商测试尚未启用", 503, { providerConfigId: id });
    }
    const hosts = allowedCallbackHosts();
    if (!hosts.length) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付回调 Host allowlist 尚未配置", 503);
    const pool = await getPostgresPool();
    const provider = await pool.query<{ provider: string; secret_configuration_version: string | null }>(`
      SELECT provider,secret_configuration_version FROM payment_provider_configs WHERE id=$1 LIMIT 1
    `, [id]);
    const row = provider.rows[0];
    if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅实现优盾回调测试", 409);
    const configurationVersion = row.secret_configuration_version;
    if (!configurationVersion) throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "必须先应用优盾商户配置", 503);
    const correlation = maintenanceCorrelation(request);
    const result = await runMaintenanceIdempotentExternalCommand<TestResponse>(pool, {
      operation: "maintenance.payment_provider.callback_test", actorUserId: user.id,
      subjectType: "payment_provider_config", subjectId: id,
      idempotencyKey: idempotencyKey(request), payload: { reason, configurationVersion },
      ...correlation,
    }, async () => {
      const startedAt = new Date();
      let errorCode: string | null = null;
      try {
        const runtime = await resolveUdunRuntimeConfig("maintenance");
        if (runtime.managedConfigurationVersion !== configurationVersion) throw new Error("PAYMENT_SECRET_VERSION_MISMATCH");
        await probeUdunCallbackReadiness({ callbackUrl: runtime.callbackUrl, allowedHosts: hosts });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        errorCode = /^[A-Z0-9_:-]{1,80}$/.test(message) ? message : "UDUN_CALLBACK_PROBE_FAILED";
      }
      const completedAt = new Date();
      const status = errorCode ? "failed" as const : "passed" as const;
      const response: TestResponse = {
        ok: !errorCode, status, providerConfigId: id, configurationVersion,
        testedAt: completedAt.toISOString(), errorCode,
      };
      return {
        terminalStatus: errorCode ? "failed" as const : "succeeded" as const,
        responseStatus: errorCode ? 503 : 200,
        errorCode,
        response,
        finalize: async client => {
          await client.query(`UPDATE payment_provider_configs SET last_callback_test_at=$2,
            last_callback_test_status=$3,last_callback_test_configuration_version=$4,
            last_callback_error_code=$5,updated_at=$2
            WHERE id=$1 AND secret_configuration_version=$4`, [id, completedAt, status, configurationVersion, errorCode]);
          await recordPaymentProviderTestRun(client, {
            providerConfigId: id, kind: "callback_readiness", status, configurationVersion,
            errorCode, actorUserId: user.id, reason, ...correlation, startedAt, completedAt,
          });
          await recordMaintenanceAudit(client, {
            actorUserId: user.id,
            action: status === "passed" ? "maintenance.payment_callback_test_passed" : "maintenance.payment_callback_test_failed",
            subjectType: "payment_provider_config", subjectId: id, reason, errorCode, ...correlation,
          });
        },
      };
    });
    if (result.terminalStatus !== "succeeded") {
      throw new ResearchApiError(result.errorCode ?? "PAYMENT_CALLBACK_UNAVAILABLE",
        result.errorCode === "MAINTENANCE_RECONCILIATION_REQUIRED"
          ? "上一次回调测试结果未知，系统未重复发送探测" : "优盾公网回调探测失败",
        result.responseStatus, { ...result.response, replayed: result.replayed });
    }
    return Response.json(result.response, { headers: {
      "cache-control": "no-store", "idempotency-replayed": String(result.replayed),
    } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
