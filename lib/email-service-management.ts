import type { Pool, PoolClient } from "pg";

import {
  deriveEmailServiceEffectiveStatus,
  maskEmailAddress,
  normalizeEmailTestHistoryLimit,
  providerMessageReference,
  type EmailConfigurationAction,
  type EmailDeliveryStatus,
  type EmailTestRecord,
} from "../packages/notifications/src/email-service-management.ts";
import { maintenanceCorrelation, recordMaintenanceAudit } from "./maintenance-audit.ts";
import { decryptEmailTestRecipient } from "./email-test-recipient-crypto.ts";
import {
  notificationRecipientHash,
  providerConfigAllowsSend,
  validateEmailRecipient,
} from "./notification-email-worker.ts";
import { NOTIFICATION_CONTACT_ADDRESSES, RESEND_SENDER_ADDRESS, RESEND_SENDER_DOMAIN } from "./notifications.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

type ProviderRow = {
  id: string;
  status: string;
  sender_domain: string | null;
  settings_json: Record<string, unknown> | string;
  last_test_at: Date | string | null;
};

type WorkerRow = {
  heartbeat_at: Date | string | null;
  status: string;
  metadata_json: Record<string, unknown> | string;
};

type DeliveryRow = {
  id: string;
  user_id: string;
  email: string;
  test_recipient_id: string | null;
  recipient_ciphertext: string | null;
  recipient_mask: string | null;
  status: string;
  scheduled_at: Date | string;
  created_at: Date | string;
  sent_at: Date | string | null;
  provider_event_at: Date | string | null;
  provider_event_type: string | null;
  provider_message_id: string | null;
  last_error: string | null;
};

function objectValue(value: unknown) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function deliveryStatus(value: string): EmailDeliveryStatus {
  return value === "sent" || value === "delivered" || value === "failed" ? value : "queued";
}

async function projectEmailTest(
  row: DeliveryRow,
  viewerUserId: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<EmailTestRecord> {
  const ownsRecord = row.user_id === viewerUserId;
  let recipient = ownsRecord ? row.email.trim().toLowerCase() : maskEmailAddress(row.email);
  let recipientVisibility: "full" | "masked" = ownsRecord ? "full" : "masked";
  if (row.test_recipient_id) {
    recipient = row.recipient_mask ?? "••••••••";
    recipientVisibility = "masked";
    if (row.recipient_ciphertext) {
      try {
        recipient = await decryptEmailTestRecipient(row.recipient_ciphertext, environment);
        recipientVisibility = "full";
      } catch {
        // Keep the durable mask if the dedicated key is unavailable or the row is a tombstone.
      }
    }
  }
  return {
    id: row.id,
    recipient,
    recipientVisibility,
    status: deliveryStatus(row.status),
    queuedAt: iso(row.scheduled_at) ?? iso(row.created_at) ?? new Date(0).toISOString(),
    sentAt: iso(row.sent_at),
    providerEventAt: iso(row.provider_event_at),
    providerEventType: row.provider_event_type,
    providerMessageReference: providerMessageReference(row.provider_message_id),
    lastErrorCode: row.last_error,
  };
}

export async function emailTestRecipientAuthorization(queryable: Queryable, input: {
  userId: string;
  email: string;
}) {
  if (!validateEmailRecipient(input.email)) {
    return { address: input.email, authorized: false, suppressed: false, available: false };
  }
  const normalized = input.email.trim().toLowerCase();
  const recipientHash = notificationRecipientHash(normalized);
  const result = await queryable.query<{ authorized: boolean; suppressed: boolean }>(`
    SELECT
      EXISTS(
        SELECT 1 FROM notification_email_test_recipients
        WHERE recipient_hash=$1 AND status='active'
      ) AS authorized,
      EXISTS(
        SELECT 1 FROM notification_email_suppressions
        WHERE recipient_hash=$1 AND active=true
      ) AS suppressed
  `, [recipientHash]);
  return {
    address: normalized,
    authorized: result.rows[0]?.authorized === true,
    suppressed: result.rows[0]?.suppressed === true,
    available: true,
  };
}

async function recentEmailTests(queryable: Queryable, limit: number) {
  return queryable.query<DeliveryRow>(`
    SELECT delivery.id,delivery.user_id,users.email,delivery.test_recipient_id,
           recipient.recipient_ciphertext,recipient.recipient_mask,delivery.status,
           delivery.scheduled_at,delivery.created_at,delivery.sent_at,
           delivery.provider_event_at,delivery.provider_event_type,
           delivery.provider_message_id,delivery.last_error
      FROM notification_deliveries AS delivery
      JOIN users ON users.id=delivery.user_id
      LEFT JOIN notification_email_test_recipients AS recipient
        ON recipient.id=delivery.test_recipient_id
     WHERE delivery.channel='email' AND delivery.template_key='maintenance_email_test'
     ORDER BY delivery.created_at DESC,delivery.id DESC
     LIMIT $1
  `, [limit]);
}

export async function listEmailTestHistory(queryable: Queryable, input: {
  viewerUserId: string;
  limit?: string | null;
  environment?: Record<string, string | undefined>;
}) {
  const limit = normalizeEmailTestHistoryLimit(input.limit ?? null);
  const result = await recentEmailTests(queryable, limit);
  return {
    tests: await Promise.all(result.rows.map(row => projectEmailTest(row, input.viewerUserId, input.environment))),
    limit,
    hasMore: result.rows.length === limit,
  };
}

export async function loadEmailServiceOverview(queryable: Queryable, input: {
  viewerUserId: string;
  viewerEmail: string;
  includeTestRecipient: boolean;
  webhookSecretPresent: boolean;
  now?: Date;
}) {
  const [providerResult, workerResult, latestResult, suppressionResult, authorization] = await Promise.all([
    queryable.query<ProviderRow>(`
      SELECT id,status,sender_domain,settings_json,last_test_at
      FROM notification_provider_configs
      WHERE provider='resend' AND channel='email'
      LIMIT 1
    `),
    queryable.query<WorkerRow>(`
      SELECT heartbeat_at,status,metadata_json FROM worker_instances
      WHERE worker_type='notification'
      ORDER BY heartbeat_at DESC NULLS LAST
      LIMIT 1
    `),
    recentEmailTests(queryable, 1),
    queryable.query<{ installed: boolean }>(
      `SELECT to_regclass('notification_email_suppressions') IS NOT NULL AS installed`,
    ),
    input.includeTestRecipient
      ? emailTestRecipientAuthorization(queryable, { userId: input.viewerUserId, email: input.viewerEmail })
      : Promise.resolve(null),
  ]);
  const provider = providerResult.rows[0];
  const settings = objectValue(provider?.settings_json);
  const worker = workerResult.rows[0];
  const metadata = objectValue(worker?.metadata_json);
  const heartbeatAt = iso(worker?.heartbeat_at);
  const now = input.now ?? new Date();
  const workerEnabled = Boolean(heartbeatAt
    && now.getTime() - Date.parse(heartbeatAt) <= 60_000
    && worker?.status === "running");
  const latestTest = latestResult.rows[0]
    ? await projectEmailTest(latestResult.rows[0], input.viewerUserId)
    : null;
  const gates = {
    apiKeyPresent: metadata.apiKeyPresent === true,
    webhookSecretPresent: input.webhookSecretPresent,
    senderDomainVerified: settings.senderDomainVerified === true,
    templatesReady: settings.templatesVerified === true,
    suppressionReady: suppressionResult.rows[0]?.installed === true && settings.suppressionEnabled === true,
    workerEnabled,
    environmentSendEnabled: metadata.emailEnvironmentReady === true,
    providerAuthorized: provider?.status === "active" && settings.webhookVerified === true,
  };
  const configured = gates.apiKeyPresent
    && gates.webhookSecretPresent
    && gates.senderDomainVerified
    && gates.templatesReady
    && gates.suppressionReady;
  return {
    provider: "resend" as const,
    senderAddress: RESEND_SENDER_ADDRESS,
    senderDomain: provider?.sender_domain ?? RESEND_SENDER_DOMAIN,
    configured,
    senderDomainVerified: gates.senderDomainVerified,
    apiKeyPresent: gates.apiKeyPresent,
    webhookSecretPresent: gates.webhookSecretPresent,
    allowlistPresent: metadata.allowlistConfigured === true || authorization?.authorized === true,
    templatesReady: gates.templatesReady,
    suppressionReady: gates.suppressionReady,
    workerEnabled: gates.workerEnabled,
    environmentSendEnabled: gates.environmentSendEnabled,
    sendAuthorized: gates.providerAuthorized && gates.environmentSendEnabled,
    providerAuthorized: provider?.status === "active",
    effectiveStatus: deriveEmailServiceEffectiveStatus({ gates, latestTestStatus: latestTest?.status ?? null }),
    lastTestAt: latestTest?.queuedAt ?? iso(provider?.last_test_at),
    lastTestStatus: latestTest?.status ?? null,
    lastTestErrorCode: latestTest?.lastErrorCode ?? null,
    latestTest,
    testRecipient: authorization,
    workerHeartbeatAt: heartbeatAt,
    contactAddresses: NOTIFICATION_CONTACT_ADDRESSES,
    inboundMailboxesVerified: settings.inboundMailboxesVerified === true,
    secretCustody: {
      apiKey: "notification_worker_managed_file" as const,
      webhookSecret: "maintenance_managed_file" as const,
      browserManaged: true,
    },
  };
}

function configurationError(error: unknown) {
  if (error instanceof ResearchApiError) return error;
  if (error instanceof Error) return error;
  return new ResearchApiError("EMAIL_CONFIGURATION_FAILED", "邮件配置更新失败", 500);
}

type EmailServiceConfigurationInput = {
  actorUserId: string;
  action: EmailConfigurationAction;
  request: Request;
  webhookSecretPresent: boolean;
};

export async function applyEmailServiceConfiguration(client: PoolClient, input: EmailServiceConfigurationInput) {
  const providerResult = await client.query<ProviderRow>(`
      SELECT id,status,sender_domain,settings_json,last_test_at
      FROM notification_provider_configs
      WHERE provider='resend' AND channel='email'
      LIMIT 1 FOR UPDATE
    `);
  const provider = providerResult.rows[0];
  if (!provider) throw new ResearchApiError("EMAIL_PROVIDER_NOT_FOUND", "Resend 邮件配置不存在", 404);

  if (input.action === "activate") {
    const workerResult = await client.query<WorkerRow>(`
        SELECT heartbeat_at,status,metadata_json FROM worker_instances
        WHERE worker_type='notification'
        ORDER BY heartbeat_at DESC NULLS LAST
        LIMIT 1
      `);
    const worker = workerResult.rows[0];
    const metadata = objectValue(worker?.metadata_json);
    const heartbeatAt = iso(worker?.heartbeat_at);
    const workerAlive = Boolean(heartbeatAt
      && Date.now() - Date.parse(heartbeatAt) <= 60_000
      && worker?.status === "running");
    if (!providerConfigAllowsSend({
      provider: "resend", channel: "email", status: "active",
      sender_domain: provider.sender_domain, settings_json: provider.settings_json,
    }) || !input.webhookSecretPresent || !workerAlive
      || metadata.apiKeyPresent !== true || metadata.emailEnvironmentReady !== true) {
      throw new ResearchApiError("EMAIL_ACTIVATION_GATES_INCOMPLETE", "邮件密钥、验证事实、环境外发开关或 Worker 尚未就绪", 409);
    }
    await client.query(`UPDATE notification_provider_configs
        SET status='active',updated_by_user_id=$2,updated_at=now() WHERE id=$1`, [provider.id, input.actorUserId]);
  } else {
    await client.query(`UPDATE notification_provider_configs
        SET status='disabled',updated_by_user_id=$2,updated_at=now() WHERE id=$1`, [provider.id, input.actorUserId]);
  }

  const correlation = maintenanceCorrelation(input.request);
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: `maintenance.email_configuration.${input.action}`,
    subjectType: "notification_provider_config",
    subjectId: provider.id,
    ...correlation,
  });
  return {
    ok: true as const,
    action: input.action,
    providerAuthorized: input.action === "activate",
    secretsChanged: false as const,
  };
}

export async function updateEmailServiceConfiguration(pool: Pool, input: EmailServiceConfigurationInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyEmailServiceConfiguration(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw configurationError(error);
  } finally {
    client.release();
  }
}
