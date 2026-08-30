import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation, maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentExternalCommand } from "@/lib/maintenance-idempotency";
import { recordPaymentProviderTestRun } from "@/lib/payment-provider-test-management";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { testUdunConnectivity } from "@/lib/udun-payment";

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
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "支付服务商连通测试尚未启用", 503, { providerConfigId: id });
    }
    const pool = await getPostgresPool();
    const provider = await pool.query<{
      provider: string; settings_json: Record<string, unknown>; secret_configuration_version: string | null;
    }>("SELECT provider,settings_json,secret_configuration_version FROM payment_provider_configs WHERE id=$1 LIMIT 1", [id]);
    const row = provider.rows[0];
    if (!row) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    if (row.provider !== "udun") throw new ResearchApiError("PAYMENT_PROVIDER_UNSUPPORTED", "当前仅实现优盾连通测试", 409);
    const mainCoinType = String(row.settings_json.mainCoinType ?? "").trim();
    const tokenCoinType = String(row.settings_json.tokenCoinType ?? "").trim();
    const configurationVersion = row.secret_configuration_version;
    if (!configurationVersion || !mainCoinType || !tokenCoinType) {
      throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "必须先应用商户配置并保存币种映射", 503);
    }
    const correlation = maintenanceCorrelation(request);
    const result = await runMaintenanceIdempotentExternalCommand<TestResponse>(pool, {
      operation: "maintenance.payment_provider.test", actorUserId: user.id,
      subjectType: "payment_provider_config", subjectId: id,
      idempotencyKey: idempotencyKey(request),
      payload: { reason, configurationVersion, mainCoinType, tokenCoinType },
      ...correlation,
    }, async () => {
      const startedAt = new Date();
      let errorCode: string | null = null;
      try {
        const runtime = await resolveUdunRuntimeConfig("maintenance");
        if (runtime.managedConfigurationVersion !== configurationVersion) throw new Error("PAYMENT_SECRET_VERSION_MISMATCH");
        const tested = await testUdunConnectivity({ config: runtime, mainCoinType, tokenCoinType });
        if (tested.coin.symbol !== "USDT") throw new Error("UDUN_COIN_SYMBOL_MISMATCH");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        errorCode = error instanceof ResearchApiError ? error.code
          : /^[A-Z0-9_:-]{1,80}$/.test(message) ? message : "UDUN_CONNECTIVITY_FAILED";
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
          await client.query(`UPDATE payment_provider_configs SET last_test_at=$2,last_test_status=$3,
            last_test_configuration_version=$4,last_error_code=$5,updated_at=$2
            WHERE id=$1 AND secret_configuration_version=$4`, [id, completedAt, status, configurationVersion, errorCode]);
          await recordPaymentProviderTestRun(client, {
            providerConfigId: id, kind: "provider_connectivity", status, configurationVersion,
            errorCode, actorUserId: user.id, reason, ...correlation, startedAt, completedAt,
          });
          await recordMaintenanceAudit(client, {
            actorUserId: user.id,
            action: status === "passed" ? "maintenance.payment_test_passed" : "maintenance.payment_test_failed",
            subjectType: "payment_provider_config", subjectId: id, reason, errorCode, ...correlation,
          });
        },
      };
    });
    if (result.terminalStatus !== "succeeded") {
      throw new ResearchApiError(result.errorCode ?? "PAYMENT_PROVIDER_UNAVAILABLE",
        result.errorCode === "MAINTENANCE_RECONCILIATION_REQUIRED"
          ? "上一次连通测试结果未知，系统未重复调用外部服务" : "优盾连通测试失败",
        result.responseStatus, { ...result.response, replayed: result.replayed });
    }
    return Response.json(result.response, { headers: {
      "cache-control": "no-store", "idempotency-replayed": String(result.replayed),
    } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
