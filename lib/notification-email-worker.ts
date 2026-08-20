import type { Pool, PoolClient } from "pg";

import { RESEND_SENDER_ADDRESS, RESEND_SENDER_DOMAIN } from "./notifications.ts";
import { decryptNotificationToken } from "./notification-secrets.ts";

export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_LEASE_SECONDS = 60;
export const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";

const MAX_FIELD_LENGTH = 500;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_RENDERED_LENGTH = 20_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);

type JsonRecord = Record<string, unknown>;

export type NotificationEmail = {
  subject: string;
  text: string;
  html: string;
};

export type ClaimedEmailDelivery = {
  id: string;
  userId: string;
  templateKey: string;
  payloadJson: unknown;
  secretKind: string | null;
  secretExpiresAt: Date | string | null;
  attempts: number;
  recipient: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; errorCode: string };

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  return value as JsonRecord;
}

function parsePayload(value: unknown): JsonRecord {
  if (typeof value === "string") {
    if (value.length > MAX_RENDERED_LENGTH) throw new Error("INVALID_PAYLOAD");
    try {
      return record(JSON.parse(value));
    } catch {
      throw new Error("INVALID_PAYLOAD");
    }
  }
  return record(value);
}

async function materializeNotificationPayload(
  templateKey: string,
  value: unknown,
  secretKind: string | null,
  secretExpiresAt: Date | string | null,
  environment: Record<string, string | undefined>,
  now: Date,
) {
  const payload = parsePayload(value);
  if (templateKey !== "reset_password" && templateKey !== "internal_account_invite") return payload;
  const expiresAt = secretExpiresAt instanceof Date
    ? secretExpiresAt.getTime()
    : typeof secretExpiresAt === "string"
      ? Date.parse(secretExpiresAt)
      : Number.NaN;
  if (secretKind !== templateKey || Number.isNaN(expiresAt)) {
    throw new Error("INVALID_PAYLOAD");
  }
  if (expiresAt <= now.getTime()) throw new Error("TOKEN_EXPIRED");
  const encryptedToken = boundedString(payload, "encryptedToken", MAX_TOKEN_LENGTH * 2);
  const { encryptedToken: _encryptedToken, ...metadata } = payload;
  void _encryptedToken;
  return { ...metadata, token: await decryptNotificationToken(encryptedToken, environment) };
}

function boundedString(payload: JsonRecord, key: string, maximum = MAX_FIELD_LENGTH) {
  const value = payload[key];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error("INVALID_PAYLOAD");
  return value;
}

function boundedCount(payload: JsonRecord, key: string) {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new Error("INVALID_PAYLOAD");
  }
  return value as number;
}

function isoDate(payload: JsonRecord, key: string) {
  const value = boundedString(payload, key, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("INVALID_PAYLOAD");
  }
  return value;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function email(subject: string, lines: string[]): NotificationEmail {
  const text = lines.join("\n");
  const html = `<p>${lines.map(line => escapeHtml(line)).join("</p><p>")}</p>`;
  if (subject.length > 200 || text.length > MAX_RENDERED_LENGTH || html.length > MAX_RENDERED_LENGTH) {
    throw new Error("INVALID_PAYLOAD");
  }
  return { subject, text, html };
}

export function renderNotificationEmail(templateKey: string, payloadJson: unknown): NotificationEmail {
  const payload = parsePayload(payloadJson);
  switch (templateKey) {
    case "reset_password": {
      const token = boundedString(payload, "token", MAX_TOKEN_LENGTH);
      if (payload.audience !== "client") throw new Error("INVALID_PAYLOAD");
      const link = `https://agentnovas.com/reset-password?token=${encodeURIComponent(token)}`;
      return email("重置 AgentNovas 密码", ["我们收到了密码重置请求。", `请在一小时内打开以下链接：${link}`, "如果这不是你的操作，请忽略此邮件。"]);
    }
    case "internal_account_invite": {
      const token = boundedString(payload, "token", MAX_TOKEN_LENGTH);
      const role = boundedString(payload, "role", 80);
      if (payload.activation !== true || payload.audience !== "operations") throw new Error("INVALID_PAYLOAD");
      const link = `https://zht.agentnovas.com/reset-password?token=${encodeURIComponent(token)}`;
      return email("AgentNovas 内部账号邀请", ["你的内部账号已创建。", `角色：${role}`, `请在 48 小时内设置密码：${link}`, "密码设置完成前账户不会激活。"]);
    }
    case "team_daily_brief": {
      const date = isoDate(payload, "date");
      const month = boundedString(payload, "month", 7);
      if (!/^\d{4}-\d{2}$/.test(month) || !date.startsWith(month)) throw new Error("INVALID_PAYLOAD");
      const scope = boundedString(payload, "scope", 80);
      const summary = record(payload.summary);
      return email(`${date} 团队运营日报`, [
        `统计范围：${scope}`,
        `客户数：${boundedCount(summary, "customers")}`,
        `催收事项：${boundedCount(summary, "collections")}`,
        `已停止交易：${boundedCount(summary, "stopped")}`,
        `即将到期会员：${boundedCount(summary, "expiring")}`,
        `未平仓交易：${boundedCount(summary, "openTrades")}`,
        `未设置目标成员：${boundedCount(summary, "targetMissing")}`,
      ]);
    }
    case "strategy_delist_notice":
    case "strategy_modify_notice": {
      const strategyName = boundedString(payload, "strategyName");
      boundedString(payload, "strategyId", 128);
      const action = boundedString(payload, "action", 16);
      const expectedAction = templateKey === "strategy_delist_notice" ? "delist" : "modify";
      if (action !== expectedAction) throw new Error("INVALID_PAYLOAD");
      const noticeEndsAt = isoDate(payload, "noticeEndsAt");
      const actionLabel = action === "delist" ? "下架" : "修改";
      return email(`策略${actionLabel}通知：${strategyName}`.slice(0, 200), [
        `你正在跟随的策略“${strategyName}”已申请${actionLabel}。`,
        `通知期截止时间：${noticeEndsAt}`,
        "请在截止时间前检查你的策略跟随安排。",
      ]);
    }
    default:
      throw new Error("UNKNOWN_TEMPLATE");
  }
}

export function validateEmailRecipient(value: unknown) {
  if (typeof value !== "string" || value.length > 254) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.endsWith("@unverified.agentnovas.local")) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function notificationSendEnvironmentReady(environment: Record<string, string | undefined>) {
  return environment.NOTIFICATION_WORKER_ENABLED === "true"
    && environment.NOTIFICATION_EMAIL_SEND_ENABLED === "true"
    && environment.NODE_ENV !== "test"
    && Boolean(environment.RESEND_API_KEY?.trim());
}

export function providerConfigAllowsSend(config: unknown) {
  const candidate = record(config);
  let settings: JsonRecord;
  try {
    settings = typeof candidate.settings_json === "string"
      ? record(JSON.parse(candidate.settings_json))
      : record(candidate.settings_json);
  } catch {
    return false;
  }
  return candidate.provider === "resend"
    && candidate.channel === "email"
    && candidate.status === "active"
    && candidate.sender_domain === RESEND_SENDER_DOMAIN
    && settings.senderDomainVerified === true;
}

export function retryDelayMilliseconds(attempts: number) {
  const boundedAttempt = Math.max(1, Math.min(NOTIFICATION_MAX_ATTEMPTS, Math.trunc(attempts)));
  return Math.min(15 * 60_000, 30_000 * (2 ** (boundedAttempt - 1)));
}

export function classifyResendHttpStatus(status: number) {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500 ? "retryable" as const : "permanent" as const;
}

export async function sendResendEmail(input: {
  apiKey: string;
  deliveryId: string;
  recipient: string;
  rendered: NotificationEmail;
  fetchImplementation?: typeof fetch;
}): Promise<SendResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  try {
    const response = await fetchImplementation(RESEND_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `notification-delivery/${input.deliveryId}`,
      },
      body: JSON.stringify({
        from: RESEND_SENDER_ADDRESS,
        to: [input.recipient.trim().toLowerCase()],
        subject: input.rendered.subject,
        text: input.rendered.text,
        html: input.rendered.html,
        tags: [{ name: "notification_delivery_id", value: input.deliveryId }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { ok: false, retryable: classifyResendHttpStatus(response.status) === "retryable", errorCode: `RESEND_HTTP_${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, retryable: true, errorCode: "RESEND_INVALID_RESPONSE" };
    }
    const id = record(body).id;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) {
      return { ok: false, retryable: true, errorCode: "RESEND_INVALID_RESPONSE" };
    }
    return { ok: true, providerMessageId: id };
  } catch {
    return { ok: false, retryable: true, errorCode: "RESEND_NETWORK_ERROR" };
  }
}

export async function loadResendProviderConfig(pool: Pick<Pool, "query">) {
  const result = await pool.query(
    `SELECT provider, channel, status, sender_domain, settings_json
       FROM notification_provider_configs
      WHERE provider = 'resend' AND channel = 'email'
      LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function claimNextEmailDelivery(pool: Pick<Pool, "connect">, input: {
  workerId: string;
  now: Date;
  leaseSeconds?: number;
}): Promise<ClaimedEmailDelivery | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidate AS (
         SELECT delivery.id
           FROM notification_deliveries AS delivery
          WHERE delivery.channel = 'email'
            AND delivery.status = 'queued'
            AND delivery.attempts < $3
            AND delivery.scheduled_at::timestamptz <= $2::timestamptz
            AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at <= $2::timestamptz)
          ORDER BY delivery.scheduled_at, delivery.id
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT 1
       )
       UPDATE notification_deliveries AS delivery
          SET lease_owner = $1,
              lease_expires_at = $2::timestamptz + ($4 * interval '1 second'),
              attempts = delivery.attempts + 1,
              updated_at = $2
         FROM candidate, users
        WHERE delivery.id = candidate.id
          AND users.id = delivery.user_id
       RETURNING delivery.id,
                 delivery.user_id AS "userId",
                 delivery.template_key AS "templateKey",
                 delivery.payload_json AS "payloadJson",
                 delivery.secret_kind AS "secretKind",
                 delivery.secret_expires_at AS "secretExpiresAt",
                 delivery.attempts,
                 users.email AS recipient`,
      [input.workerId, input.now.toISOString(), NOTIFICATION_MAX_ATTEMPTS, input.leaseSeconds ?? NOTIFICATION_LEASE_SECONDS],
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function fencedUpdate(pool: Pick<Pool, "query">, sql: string, parameters: unknown[]) {
  const result = await pool.query(sql, parameters);
  return (result.rowCount ?? 0) === 1;
}

export async function markEmailSent(pool: Pick<Pool, "query">, input: {
  deliveryId: string;
  workerId: string;
  providerMessageId: string;
  now: Date;
}) {
  return fencedUpdate(pool,
    `UPDATE notification_deliveries
        SET status = CASE WHEN status IN ('delivered', 'failed') THEN status ELSE 'sent' END,
            provider_message_id = $3,
            sent_at = COALESCE(sent_at, $4),
            payload_json = CASE WHEN template_key IN ('reset_password', 'internal_account_invite') THEN '{}' ELSE payload_json END,
            secret_kind = CASE WHEN template_key IN ('reset_password', 'internal_account_invite') THEN NULL ELSE secret_kind END,
            secret_expires_at = CASE WHEN template_key IN ('reset_password', 'internal_account_invite') THEN NULL ELSE secret_expires_at END,
            last_error = CASE WHEN status = 'failed' THEN last_error ELSE NULL END,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = $4
      WHERE id = $1 AND lease_owner = $2
        AND (provider_message_id IS NULL OR provider_message_id = $3)`,
    [input.deliveryId, input.workerId, input.providerMessageId, input.now.toISOString()],
  );
}

export async function markEmailFailed(pool: Pick<Pool, "query">, input: {
  deliveryId: string;
  workerId: string;
  errorCode: string;
  retryable: boolean;
  attempts: number;
  now: Date;
}) {
  const retry = input.retryable && input.attempts < NOTIFICATION_MAX_ATTEMPTS;
  const scheduledAt = new Date(input.now.getTime() + retryDelayMilliseconds(input.attempts)).toISOString();
  return fencedUpdate(pool,
    `UPDATE notification_deliveries
        SET status = $3, last_error = $4, scheduled_at = CASE WHEN $3 = 'queued' THEN $5 ELSE scheduled_at END,
            payload_json = CASE WHEN $3 = 'failed' AND template_key IN ('reset_password', 'internal_account_invite') THEN '{}' ELSE payload_json END,
            secret_kind = CASE WHEN $3 = 'failed' AND template_key IN ('reset_password', 'internal_account_invite') THEN NULL ELSE secret_kind END,
            secret_expires_at = CASE WHEN $3 = 'failed' AND template_key IN ('reset_password', 'internal_account_invite') THEN NULL ELSE secret_expires_at END,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = $6
      WHERE id = $1 AND lease_owner = $2`,
    [input.deliveryId, input.workerId, retry ? "queued" : "failed", input.errorCode.slice(0, 200), scheduledAt, input.now.toISOString()],
  );
}

export async function purgeExpiredNotificationSecrets(pool: Pick<Pool, "query">, now = new Date()) {
  const result = await pool.query(
    `UPDATE notification_deliveries
        SET payload_json = '{}',
            secret_kind = NULL,
            secret_expires_at = NULL,
            status = CASE WHEN status = 'queued' THEN 'failed' ELSE status END,
            last_error = CASE WHEN status = 'queued' THEN 'TOKEN_EXPIRED' ELSE last_error END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $1
      WHERE secret_kind IN ('reset_password', 'internal_account_invite')
        AND (
          status IN ('sent', 'delivered', 'failed')
          OR secret_expires_at <= $1::timestamptz
        )`,
    [now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function processClaimedEmail(pool: Pick<Pool, "query">, delivery: ClaimedEmailDelivery, input: {
  workerId: string;
  apiKey: string;
  now?: () => Date;
  send?: typeof sendResendEmail;
  environment?: Record<string, string | undefined>;
}) {
  let rendered: NotificationEmail;
  let errorCode: string | null = null;
  const processingStartedAt = input.now?.() ?? new Date();
  if (!validateEmailRecipient(delivery.recipient)) {
    errorCode = "INVALID_RECIPIENT";
  } else {
    try {
      const payload = await materializeNotificationPayload(
        delivery.templateKey,
        delivery.payloadJson,
        delivery.secretKind,
        delivery.secretExpiresAt,
        input.environment ?? process.env,
        processingStartedAt,
      );
      rendered = renderNotificationEmail(delivery.templateKey, payload);
    } catch (error) {
      errorCode = error instanceof Error && ["UNKNOWN_TEMPLATE", "TOKEN_EXPIRED"].includes(error.message)
        ? error.message
        : "INVALID_PAYLOAD";
    }
  }
  if (errorCode) {
    await markEmailFailed(pool, { deliveryId: delivery.id, workerId: input.workerId, errorCode, retryable: false, attempts: delivery.attempts, now: input.now?.() ?? new Date() });
    return { status: "failed" as const, errorCode };
  }
  const result = await (input.send ?? sendResendEmail)({
    apiKey: input.apiKey,
    deliveryId: delivery.id,
    recipient: delivery.recipient,
    rendered: rendered!,
  });
  if (result.ok) {
    const updated = await markEmailSent(pool, { deliveryId: delivery.id, workerId: input.workerId, providerMessageId: result.providerMessageId, now: input.now?.() ?? new Date() });
    if (!updated) return { status: "fenced" as const, providerMessageId: result.providerMessageId };
    return { status: "sent" as const, providerMessageId: result.providerMessageId };
  }
  const updated = await markEmailFailed(pool, { deliveryId: delivery.id, workerId: input.workerId, errorCode: result.errorCode, retryable: result.retryable, attempts: delivery.attempts, now: input.now?.() ?? new Date() });
  if (!updated) return { status: "fenced" as const, errorCode: result.errorCode };
  return { status: result.retryable && delivery.attempts < NOTIFICATION_MAX_ATTEMPTS ? "retrying" as const : "failed" as const, errorCode: result.errorCode };
}

export type NotificationPool = Pick<Pool, "query" | "connect">;
export type NotificationClient = Pick<PoolClient, "query" | "release">;
