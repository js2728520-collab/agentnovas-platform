import { requireAnyAccessPermission } from "@/lib/access-control";
import { resolveUdunRuntimeConfig } from "@/lib/payment-secret-broker";
import { loadPaymentSecretManagementStatus } from "@/lib/payment-secret-management";
import { listPaymentProviderTestRuns } from "@/lib/payment-provider-test-management";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { paymentActivationGate } from "@/packages/payments/src/udun-service-management";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.payment_integrations.manage"]);
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string; provider: string; channel: string; network: string | null; status: string;
      confirmation_threshold: number | null; settings_json: Record<string, unknown>; updated_at: Date;
      encrypted_secret_ref: string | null; last_test_at: Date | null; last_test_status: string | null;
      last_error_code: string | null; secret_configuration_version: string | null;
      secret_configuration_fingerprint: string | null; last_test_configuration_version: string | null;
      last_callback_test_at: Date | null; last_callback_test_status: string | null;
      last_callback_test_configuration_version: string | null; last_callback_error_code: string | null;
    }>(`
      SELECT id,provider,channel,network,status,confirmation_threshold,settings_json,updated_at,
        encrypted_secret_ref,last_test_at,last_test_status,last_error_code,
        secret_configuration_version,secret_configuration_fingerprint,last_test_configuration_version,
        last_callback_test_at,last_callback_test_status,last_callback_test_configuration_version,last_callback_error_code
      FROM payment_provider_configs ORDER BY channel ASC,provider ASC,network ASC NULLS FIRST
    `);
    const broker = await loadPaymentSecretManagementStatus(pool);
    let runtimeConfigurationVersion: string | null = null;
    try { runtimeConfigurationVersion = (await resolveUdunRuntimeConfig("maintenance")).managedConfigurationVersion; }
    catch { runtimeConfigurationVersion = null; }
    const providerAuthorized = process.env.PAYMENT_PROVIDER_OUTBOUND_ENABLED === "true";
    return Response.json({
      providers: result.rows.map((row) => {
        const coinMappingConfigured = Boolean(String(row.settings_json.mainCoinType ?? "").trim()
          && String(row.settings_json.tokenCoinType ?? "").trim());
        const hasSecret = row.provider === "udun"
          ? Boolean(runtimeConfigurationVersion && runtimeConfigurationVersion === row.secret_configuration_version)
          : Boolean(row.encrypted_secret_ref);
        const activation = row.provider === "udun" ? paymentActivationGate({
          secretConfigured: hasSecret, brokerAvailable: broker.broker.available, coinMappingConfigured,
          providerAuthorized, configurationVersion: row.secret_configuration_version,
          providerTest: { status: row.last_test_status, at: row.last_test_at?.toISOString() ?? null,
            configurationVersion: row.last_test_configuration_version },
          callbackTest: { status: row.last_callback_test_status, at: row.last_callback_test_at?.toISOString() ?? null,
            configurationVersion: row.last_callback_test_configuration_version },
        }) : { ready: false, blockers: ["PAYMENT_PROVIDER_UNSUPPORTED"] };
        return {
          id: row.id, provider: row.provider, channel: row.channel, network: row.network,
          configuredStatus: row.status,
          effectiveStatus: row.status === "disabled" ? "disabled" : activation.ready ? "active" : "degraded",
          confirmationThreshold: row.confirmation_threshold, hasSecret,
          merchantConfigured: row.provider === "udun" && hasSecret,
          gatewayConfigured: row.provider === "udun" && hasSecret,
          callbackConfigured: row.provider === "udun" && hasSecret,
          coinMappingConfigured,
          protocol: typeof row.settings_json.protocol === "string" ? row.settings_json.protocol : null,
          addressRequestCoinField: hasSecret ? "configured" : null,
          configurationVersion: row.secret_configuration_version,
          configurationFingerprint: row.secret_configuration_fingerprint,
          brokerAvailable: broker.broker.available,
          providerAuthorized,
          activationReady: activation.ready,
          activationBlockers: activation.blockers,
          lastTestAt: row.last_test_at?.toISOString() ?? null,
          lastTestStatus: row.last_test_status,
          lastErrorCode: row.last_error_code,
          lastCallbackTestAt: row.last_callback_test_at?.toISOString() ?? null,
          lastCallbackTestStatus: row.last_callback_test_status,
          lastCallbackErrorCode: row.last_callback_error_code,
          updatedAt: row.updated_at.toISOString(),
        };
      }),
      secretManagement: broker,
      testHistory: await listPaymentProviderTestRuns(pool),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
