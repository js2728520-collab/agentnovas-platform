import { requireAccessPermission } from "@/lib/access-control";
import { canonicalPayloadHash } from "@/lib/commercial-idempotency";
import { maintenanceCorrelation, maintenanceReason, recordMaintenanceAudit } from "@/lib/maintenance-audit";
import { maintenanceIdempotencyKeyHash } from "@/lib/maintenance-idempotency";
import { providerConfigAllowsSend, validateEmailRecipient } from "@/lib/notification-email-worker";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    if (!validateEmailRecipient(user.email)) throw new ResearchApiError("TEST_RECIPIENT_UNAVAILABLE", "当前管理员没有可用于测试的有效邮箱", 422);
    const pool = await getPostgresPool();
    const queuedAt = new Date().toISOString();
    const deliveryId = crypto.randomUUID();
    const correlation = maintenanceCorrelation(request);
    const idempotencyKeyHash = maintenanceIdempotencyKeyHash(request.headers.get("idempotency-key") ?? "");
    const requestFingerprint = canonicalPayloadHash({ actorUserId: user.id, reason });
    const dedupeKey = `maintenance-email-test:${idempotencyKeyHash}`;
    const client = await pool.connect();
    let delivery: { id: string; status: string; scheduled_at: Date | string } | undefined;
    try {
      await client.query("BEGIN");
      const provider = await client.query(`
        SELECT provider,channel,status,sender_domain,settings_json
        FROM notification_provider_configs
        WHERE provider='resend' AND channel='email'
        LIMIT 1
        FOR SHARE
      `);
      const providerRow = provider.rows[0];
      if (!providerConfigAllowsSend(providerRow)) {
        throw new ResearchApiError("SERVICE_NOT_READY", "邮件 Provider 尚未完成域名、Webhook、模板和抑制列表配置", 503);
      }
      const worker = await client.query<{ heartbeat_at: Date; status: string; metadata_json: Record<string, unknown> }>(`
        SELECT heartbeat_at,status,metadata_json FROM worker_instances
        WHERE worker_type='notification'
        ORDER BY heartbeat_at DESC NULLS LAST
        LIMIT 1
      `);
      const workerRow = worker.rows[0];
      const workerMetadata = workerRow?.metadata_json && typeof workerRow.metadata_json === "object"
        ? workerRow.metadata_json
        : {};
      if (!workerRow
        || workerRow.status !== "running"
        || Date.now() - workerRow.heartbeat_at.getTime() > 60_000
        || workerMetadata.emailEnvironmentReady !== true) {
        throw new ResearchApiError("WORKER_NOT_READY", "Notification Worker 未运行或尚未获得受控邮件外发授权", 503);
      }
      const inserted = await client.query<{ id: string; status: string; scheduled_at: Date | string }>(`
        INSERT INTO notification_deliveries(
          id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key
        ) VALUES($1,$2,'email','api_security','maintenance_email_test',$3,'queued',$4,$5)
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id,status,scheduled_at
      `, [deliveryId,user.id,JSON.stringify({ requestedAt: queuedAt, requestFingerprint }),queuedAt,dedupeKey]);
      delivery = inserted.rows[0];
      if (!delivery) {
        const existing = await client.query<{
          id: string;
          user_id: string;
          status: string;
          scheduled_at: Date | string;
          payload_json: { requestFingerprint?: unknown } | string;
        }>(`
          SELECT id,user_id,status,scheduled_at,payload_json FROM notification_deliveries
          WHERE dedupe_key=$1
          LIMIT 1
        `, [dedupeKey]);
        const replay = existing.rows[0];
        const replayPayload = typeof replay?.payload_json === "string"
          ? JSON.parse(replay.payload_json) as { requestFingerprint?: unknown }
          : replay?.payload_json;
        if (!replay
          || replay.user_id !== user.id
          || replayPayload?.requestFingerprint !== requestFingerprint) {
          throw new ResearchApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于其他邮件测试请求", 409);
        }
        delivery = replay;
      } else {
        await client.query(`
          UPDATE notification_provider_configs SET last_test_at=$1,updated_at=now()
          WHERE provider='resend' AND channel='email'
        `, [queuedAt]);
        await recordMaintenanceAudit(client, {
          actorUserId: user.id,
          action: "maintenance.email_test_queued",
          subjectType: "notification_delivery",
          subjectId: delivery.id,
          reason,
          ...correlation,
        });
      }
      if (!delivery) throw new ResearchApiError("QUEUE_WRITE_FAILED", "测试邮件未能写入发送队列", 503);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({
      ok: true,
      status: delivery.status,
      deliveryId: delivery.id,
      message: "测试邮件请求已记录；当前状态不代表已发送或已送达",
      queuedAt: new Date(delivery.scheduled_at).toISOString(),
    }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
