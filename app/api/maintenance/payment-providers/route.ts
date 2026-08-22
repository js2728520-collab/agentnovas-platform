import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.payment_integrations.manage"]);
    const result = await (await getPostgresPool()).query<{
      id: string; provider: string; channel: string; network: string | null; status: string;
      confirmation_threshold: number | null; settings_json: Record<string, unknown>; updated_at: Date;
      encrypted_secret_ref: string | null; last_test_at: Date | null; last_test_status: string | null;
      last_error_code: string | null;
    }>(`
      SELECT id,provider,channel,network,status,confirmation_threshold,settings_json,updated_at,
        encrypted_secret_ref,last_test_at,last_test_status,last_error_code
      FROM payment_provider_configs ORDER BY channel ASC,provider ASC,network ASC NULLS FIRST
    `);
    const merchantConfigured = Boolean(process.env.UDUN_MERCHANT_ID?.trim());
    const gatewayConfigured = Boolean(process.env.UDUN_GATEWAY_BASE_URL?.trim());
    const callbackConfigured = Boolean(process.env.UDUN_CALLBACK_URL?.trim());
    const runtimeSecretPresent = Boolean(process.env.UDUN_API_KEY?.trim());
    return Response.json({
      providers: result.rows.map((row) => {
        const coinMappingConfigured = Boolean(String(row.settings_json.mainCoinType ?? "").trim()
          && String(row.settings_json.tokenCoinType ?? "").trim());
        const hasSecret = row.provider === "udun" ? runtimeSecretPresent : Boolean(row.encrypted_secret_ref);
        const complete = row.provider !== "udun" || (merchantConfigured && gatewayConfigured && callbackConfigured && hasSecret && coinMappingConfigured);
        return {
          id: row.id, provider: row.provider, channel: row.channel, network: row.network,
          configuredStatus: row.status,
          effectiveStatus: row.status === "disabled" ? "disabled" : complete ? "active" : "incomplete",
          confirmationThreshold: row.confirmation_threshold, hasSecret,
          merchantConfigured: row.provider === "udun" && merchantConfigured,
          gatewayConfigured: row.provider === "udun" && gatewayConfigured,
          callbackConfigured: row.provider === "udun" && callbackConfigured,
          coinMappingConfigured,
          protocol: typeof row.settings_json.protocol === "string" ? row.settings_json.protocol : null,
          lastTestAt: row.last_test_at?.toISOString() ?? null,
          lastTestStatus: row.last_test_status,
          lastErrorCode: row.last_error_code,
          updatedAt: row.updated_at.toISOString(),
        };
      }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
