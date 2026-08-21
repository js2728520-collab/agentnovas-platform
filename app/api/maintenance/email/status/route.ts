import { requireAnyAccessPermission } from "@/lib/access-control";
import { publicEmailIntegrationStatus } from "@/lib/notifications";
import { notificationEmailAllowlist } from "@/lib/notification-email-worker";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.email_integrations.manage"]);
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
    const settings = row?.settings_json && typeof row.settings_json === "object" ? row.settings_json : {};
    const suppression = await pool.query<{ installed: boolean }>(
      `SELECT to_regclass('notification_email_suppressions') IS NOT NULL AS installed`,
    );
    return Response.json(publicEmailIntegrationStatus({
      configured: Boolean(row && row.status !== "disabled" && (row.encrypted_secret_ref || process.env.RESEND_API_KEY?.trim())),
      senderDomainVerified: Boolean(row?.settings_json?.senderDomainVerified),
      apiKeyPresent: Boolean(row?.encrypted_secret_ref || process.env.RESEND_API_KEY),
      webhookSecretPresent: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
      allowlistPresent: notificationEmailAllowlist(process.env).size > 0,
      templatesReady: settings.templatesVerified === true,
      suppressionReady: suppression.rows[0]?.installed === true && settings.suppressionEnabled === true,
      workerEnabled: process.env.NOTIFICATION_WORKER_ENABLED === "true",
      sendAuthorized: process.env.NOTIFICATION_EMAIL_SEND_ENABLED === "true" && settings.webhookVerified === true,
      lastTestAt: row?.last_test_at?.toISOString() ?? null,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
