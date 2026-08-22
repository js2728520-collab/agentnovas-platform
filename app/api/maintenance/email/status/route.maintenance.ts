import { requireAnyAccessPermission } from "@/lib/access-control";
import { publicEmailIntegrationStatus } from "@/lib/notifications";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.email_integrations.manage"]);
    const pool = await getPostgresPool();
    const result = await pool.query<{
      status: string;
      sender_domain: string | null;
      settings_json: Record<string, unknown>;
      last_test_at: Date | null;
    }>(`
      SELECT status, sender_domain, settings_json, last_test_at
      FROM notification_provider_configs
      WHERE provider = 'resend' AND channel = 'email'
      LIMIT 1
    `);
    const row = result.rows[0];
    const settings = row?.settings_json && typeof row.settings_json === "object" ? row.settings_json : {};
    const suppression = await pool.query<{ installed: boolean }>(
      `SELECT to_regclass('notification_email_suppressions') IS NOT NULL AS installed`,
    );
    const latestTest = await pool.query<{
      status: string;
      last_error: string | null;
      created_at: string;
    }>(`
      SELECT status,last_error,created_at
      FROM notification_deliveries
      WHERE channel='email' AND template_key='maintenance_email_test'
      ORDER BY created_at DESC,id DESC
      LIMIT 1
    `);
    const worker = await pool.query<{
      heartbeat_at: Date | null;
      status: string;
      metadata_json: Record<string, unknown>;
    }>(`
      SELECT heartbeat_at,status,metadata_json FROM worker_instances
      WHERE worker_type='notification'
      ORDER BY heartbeat_at DESC NULLS LAST
      LIMIT 1
    `);
    const workerRow = worker.rows[0];
    const workerHeartbeatAt = workerRow?.heartbeat_at?.toISOString() ?? null;
    const workerAlive = Boolean(workerHeartbeatAt
      && Date.now() - Date.parse(workerHeartbeatAt) <= 60_000
      && workerRow.status === "running");
    const metadata = workerRow?.metadata_json && typeof workerRow.metadata_json === "object"
      ? workerRow.metadata_json
      : {};
    return Response.json(publicEmailIntegrationStatus({
      configured: Boolean(row && row.status !== "disabled" && metadata.apiKeyPresent === true),
      senderDomainVerified: Boolean(row?.settings_json?.senderDomainVerified),
      apiKeyPresent: metadata.apiKeyPresent === true,
      webhookSecretPresent: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
      allowlistPresent: metadata.allowlistConfigured === true,
      templatesReady: settings.templatesVerified === true,
      suppressionReady: suppression.rows[0]?.installed === true && settings.suppressionEnabled === true,
      workerEnabled: workerAlive,
      sendAuthorized: row?.status === "active"
        && metadata.emailEnvironmentReady === true
        && settings.webhookVerified === true,
      lastTestAt: row?.last_test_at?.toISOString() ?? null,
      lastTestStatus: latestTest.rows[0]?.status ?? null,
      lastTestErrorCode: latestTest.rows[0]?.last_error ?? null,
      workerHeartbeatAt,
      inboundMailboxesVerified: settings.inboundMailboxesVerified === true,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
