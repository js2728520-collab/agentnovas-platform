import { requireAccessPermission } from "@/lib/access-control";
import { publicEmailIntegrationStatus } from "@/lib/notifications";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.system_health.view");
    const pool = await getPostgresPool();
    const result = await pool.query<{
      status: string;
      sender_domain: string | null;
      encrypted_secret_ref: string | null;
      settings_json: Record<string, unknown>;
      last_test_at: Date | null;
    }>(`
      SELECT status, sender_domain, encrypted_secret_ref, settings_json, last_test_at
      FROM notification_provider_configs
      WHERE provider = 'resend' AND channel = 'email'
      LIMIT 1
    `);
    const row = result.rows[0];
    return Response.json(publicEmailIntegrationStatus({
      configured: Boolean(row && row.status !== "disabled" && row.encrypted_secret_ref),
      senderDomainVerified: Boolean(row?.settings_json?.senderDomainVerified),
      apiKeyPresent: Boolean(row?.encrypted_secret_ref || process.env.RESEND_API_KEY),
      lastTestAt: row?.last_test_at?.toISOString() ?? null,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

