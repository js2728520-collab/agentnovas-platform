import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { EmailRecipientAction, EmailTestRecipient } from "../packages/notifications/src/email-service-management.ts";
import { maskEmailAddress } from "../packages/notifications/src/email-service-management.ts";
import {
  decryptEmailTestRecipient,
  emailVerificationCodeMatches,
  encryptEmailTestRecipient,
  encryptEmailVerificationCode,
  hashEmailVerificationCode,
} from "./email-test-recipient-crypto.ts";
import { automaticAuditReason, maintenanceCorrelation, recordMaintenanceAudit } from "./maintenance-audit.ts";
import { notificationRecipientHash } from "./notification-email-worker.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type Environment = Record<string, string | undefined>;

type RecipientRow = {
  id: string;
  recipient_hash: string;
  recipient_ciphertext: string | null;
  recipient_mask: string;
  label: string;
  status: "pending_verification" | "active" | "disabled" | "deleted";
  verification_code_hash: string | null;
  verification_expires_at: Date | string | null;
  verification_attempts: number;
  verification_sent_at: Date | string | null;
  verified_at: Date | string | null;
  updated_at: Date | string;
  updated_by_email: string | null;
  suppressed: boolean;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function verificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function projectRecipient(row: RecipientRow, environment: Environment): Promise<EmailTestRecipient> {
  let address = row.recipient_mask;
  if (row.recipient_ciphertext) {
    try {
      address = await decryptEmailTestRecipient(row.recipient_ciphertext, environment);
    } catch {
      address = row.recipient_mask;
    }
  }
  return {
    id: row.id,
    label: row.label,
    address,
    mask: row.recipient_mask,
    status: row.status,
    suppressed: row.suppressed,
    verificationSentAt: iso(row.verification_sent_at),
    verificationExpiresAt: iso(row.verification_expires_at),
    verifiedAt: iso(row.verified_at),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    updatedBy: row.updated_by_email ? maskEmailAddress(row.updated_by_email) : null,
  };
}

const RECIPIENT_SELECT = `
  SELECT recipient.id,recipient.recipient_hash,recipient.recipient_ciphertext,
         recipient.recipient_mask,recipient.label,recipient.status,
         recipient.verification_code_hash,recipient.verification_expires_at,
         recipient.verification_attempts,recipient.verification_sent_at,
         recipient.verified_at,recipient.updated_at,updater.email AS updated_by_email,
         EXISTS(
           SELECT 1 FROM notification_email_suppressions AS suppression
            WHERE suppression.recipient_hash=recipient.recipient_hash
              AND suppression.active=true
         ) AS suppressed
    FROM notification_email_test_recipients AS recipient
    LEFT JOIN users AS updater ON updater.id=recipient.updated_by_user_id
`;

export async function listEmailTestRecipients(
  queryable: Queryable,
  environment: Environment = process.env,
) {
  const result = await queryable.query<RecipientRow>(`${RECIPIENT_SELECT}
    WHERE recipient.status<>'deleted'
    ORDER BY recipient.created_at,recipient.id`);
  return Promise.all(result.rows.map(row => projectRecipient(row, environment)));
}

async function recipientById(queryable: Queryable, recipientId: string, forUpdate = false) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(recipientId)) throw new ResearchApiError("TEST_RECIPIENT_NOT_FOUND", "测试收件地址不存在", 404);
  const result = await queryable.query<RecipientRow>(`${RECIPIENT_SELECT}
    WHERE recipient.id=$1 ${forUpdate ? "FOR UPDATE OF recipient" : ""}`, [recipientId]);
  const row = result.rows[0];
  if (!row || row.status === "deleted") throw new ResearchApiError("TEST_RECIPIENT_NOT_FOUND", "测试收件地址不存在", 404);
  return row;
}

async function queueVerification(client: PoolClient, input: {
  actorUserId: string;
  recipientId: string;
  label: string;
  code: string;
  expiresAt: Date;
  dedupeKey: string;
  environment: Environment;
}) {
  const deliveryId = crypto.randomUUID();
  const encryptedCode = await encryptEmailVerificationCode(input.code, input.environment);
  const now = new Date().toISOString();
  await client.query(`
    INSERT INTO notification_deliveries(
      id,user_id,test_recipient_id,channel,category,template_key,payload_json,
      status,scheduled_at,dedupe_key,secret_kind,secret_expires_at
    ) VALUES(
      $1,$2,$3,'email','api_security','maintenance_email_recipient_verification',$4,
      'queued',$5,$6,'maintenance_email_recipient_verification',$7
    )
  `, [
    deliveryId,
    input.actorUserId,
    input.recipientId,
    JSON.stringify({ encryptedCode, label: input.label }),
    now,
    input.dedupeKey,
    input.expiresAt.toISOString(),
  ]);
  return deliveryId;
}

export async function createEmailTestRecipient(client: PoolClient, input: {
  actorUserId: string;
  email: string;
  label: string;
  request: Request;
  idempotencyHash: string;
  environment?: Environment;
  now?: Date;
  verificationCodeFactory?: () => string;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  const normalized = input.email.trim().toLowerCase();
  const recipientHash = notificationRecipientHash(normalized);
  const existing = await client.query<{ id: string; status: string }>(`
    SELECT id,status FROM notification_email_test_recipients WHERE recipient_hash=$1 FOR UPDATE
  `, [recipientHash]);
  if (existing.rows[0] && existing.rows[0].status !== "deleted") {
    throw new ResearchApiError("TEST_RECIPIENT_ALREADY_EXISTS", "该测试收件地址已经存在", 409);
  }
  const recipientId = existing.rows[0]?.id ?? crypto.randomUUID();
  const code = input.verificationCodeFactory?.() ?? verificationCode();
  if (!/^\d{6}$/.test(code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
  const ciphertext = await encryptEmailTestRecipient(normalized, environment);
  const codeHash = hashEmailVerificationCode(recipientId, code, environment);
  const mask = maskEmailAddress(normalized);
  const auditAction = "maintenance.email_recipient_created";
  const reason = automaticAuditReason(auditAction);
  await client.query(`
    INSERT INTO notification_email_test_recipients(
      id,recipient_hash,recipient_ciphertext,recipient_mask,label,status,
      verification_code_hash,verification_expires_at,verification_attempts,
      verification_sent_at,verified_at,deleted_at,created_by_user_id,
      updated_by_user_id,reason,authorized_at,revoked_at,created_at,updated_at,version
    ) VALUES(
      $1,$2,$3,$4,$5,'pending_verification',$6,$7,0,$8,NULL,NULL,$9,$9,$10,$8,NULL,$8,$8,1
    )
    ON CONFLICT(recipient_hash) DO UPDATE SET
      recipient_ciphertext=EXCLUDED.recipient_ciphertext,
      recipient_mask=EXCLUDED.recipient_mask,
      label=EXCLUDED.label,
      status='pending_verification',
      verification_code_hash=EXCLUDED.verification_code_hash,
      verification_expires_at=EXCLUDED.verification_expires_at,
      verification_attempts=0,
      verification_sent_at=EXCLUDED.verification_sent_at,
      verified_at=NULL,
      deleted_at=NULL,
      updated_by_user_id=EXCLUDED.updated_by_user_id,
      reason=EXCLUDED.reason,
      authorized_at=EXCLUDED.authorized_at,
      revoked_at=NULL,
      updated_at=EXCLUDED.updated_at,
      version=notification_email_test_recipients.version+1
  `, [recipientId,recipientHash,ciphertext,mask,input.label,codeHash,expiresAt,now,input.actorUserId,reason]);
  const verificationDeliveryId = await queueVerification(client, {
    actorUserId: input.actorUserId,
    recipientId,
    label: input.label,
    code,
    expiresAt,
    dedupeKey: `maintenance-email-recipient-verification:${recipientId}:${input.idempotencyHash}`,
    environment,
  });
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: auditAction,
    subjectType: "notification_email_test_recipient",
    subjectId: recipientId,
    ...maintenanceCorrelation(input.request),
  });
  const row = await recipientById(client, recipientId);
  return {
    recipient: await projectRecipient(row, environment),
    verificationDeliveryId,
    verificationStatus: "queued" as const,
  };
}

export async function loadActiveEmailTestRecipient(
  queryable: Queryable,
  recipientId: string,
  environment: Environment = process.env,
) {
  const row = await recipientById(queryable, recipientId);
  if (row.status !== "active") {
    throw new ResearchApiError("TEST_RECIPIENT_NOT_AUTHORIZED", "测试收件地址尚未验证并启用", 422, { recipientId });
  }
  if (row.suppressed) {
    throw new ResearchApiError("TEST_RECIPIENT_SUPPRESSED", "测试收件地址已因退信或投诉而被抑制", 409, { recipientId });
  }
  if (!row.recipient_ciphertext) throw new ResearchApiError("TEST_RECIPIENT_UNAVAILABLE", "测试收件地址不可用", 422);
  return {
    recipient: await projectRecipient(row, environment),
    address: await decryptEmailTestRecipient(row.recipient_ciphertext, environment),
  };
}

export async function verifyEmailTestRecipient(client: PoolClient, input: {
  actorUserId: string;
  recipientId: string;
  code: string;
  request: Request;
  environment?: Environment;
  now?: Date;
  verificationCodeFactory?: () => string;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const row = await recipientById(client, input.recipientId, true);
  if (row.status !== "pending_verification" || !row.verification_code_hash || !row.verification_expires_at) {
    throw new ResearchApiError("TEST_RECIPIENT_NOT_PENDING", "测试收件地址不在待验证状态", 409);
  }
  if (row.verification_attempts >= 5) throw new ResearchApiError("TEST_RECIPIENT_VERIFICATION_LOCKED", "验证码尝试次数已用尽，请重新发送", 429);
  if (Date.parse(String(row.verification_expires_at)) <= now.getTime()) {
    throw new ResearchApiError("TEST_RECIPIENT_CODE_EXPIRED", "验证码已过期，请重新发送", 410);
  }
  if (!emailVerificationCodeMatches(row.id, input.code, row.verification_code_hash, environment)) {
    await client.query(`UPDATE notification_email_test_recipients
      SET verification_attempts=verification_attempts+1,updated_by_user_id=$2,updated_at=$3,version=version+1
      WHERE id=$1`, [row.id,input.actorUserId,now]);
    throw new ResearchApiError("TEST_RECIPIENT_CODE_INVALID", "验证码不正确", 422, {
      attemptsRemaining: Math.max(0, 4 - row.verification_attempts),
    });
  }
  const auditAction = "maintenance.email_recipient_verified";
  const reason = automaticAuditReason(auditAction);
  await client.query(`UPDATE notification_email_test_recipients
    SET status='active',verification_code_hash=NULL,verification_expires_at=NULL,
        verification_attempts=0,verified_at=$3,authorized_at=$3,revoked_at=NULL,
        updated_by_user_id=$2,reason=$4,updated_at=$3,version=version+1
    WHERE id=$1`, [row.id,input.actorUserId,now,reason]);
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: auditAction,
    subjectType: "notification_email_test_recipient",
    subjectId: row.id,
    ...maintenanceCorrelation(input.request),
  });
  return { recipient: await projectRecipient(await recipientById(client, row.id), environment) };
}

export async function resendEmailTestRecipientVerification(client: PoolClient, input: {
  actorUserId: string;
  recipientId: string;
  request: Request;
  idempotencyHash: string;
  environment?: Environment;
  now?: Date;
  verificationCodeFactory?: () => string;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const row = await recipientById(client, input.recipientId, true);
  if (row.status !== "pending_verification") throw new ResearchApiError("TEST_RECIPIENT_NOT_PENDING", "测试收件地址不在待验证状态", 409);
  if (row.verification_sent_at && now.getTime() - Date.parse(String(row.verification_sent_at)) < 60_000) {
    throw new ResearchApiError("TEST_RECIPIENT_RESEND_RATE_LIMITED", "请在一分钟后重发验证码", 429);
  }
  const code = input.verificationCodeFactory?.() ?? verificationCode();
  if (!/^\d{6}$/.test(code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  const auditAction = "maintenance.email_recipient_verification_resent";
  const reason = automaticAuditReason(auditAction);
  await client.query(`UPDATE notification_email_test_recipients
    SET verification_code_hash=$2,verification_expires_at=$3,verification_attempts=0,
        verification_sent_at=$4,updated_by_user_id=$5,reason=$6,updated_at=$4,version=version+1
    WHERE id=$1`, [row.id,hashEmailVerificationCode(row.id,code,environment),expiresAt,now,input.actorUserId,reason]);
  const verificationDeliveryId = await queueVerification(client, {
    actorUserId: input.actorUserId,
    recipientId: row.id,
    label: row.label,
    code,
    expiresAt,
    dedupeKey: `maintenance-email-recipient-verification:${row.id}:${input.idempotencyHash}`,
    environment,
  });
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: auditAction,
    subjectType: "notification_email_test_recipient",
    subjectId: row.id,
    ...maintenanceCorrelation(input.request),
  });
  return {
    recipient: await projectRecipient(await recipientById(client,row.id),environment),
    verificationDeliveryId,
    verificationStatus: "queued" as const,
  };
}

export async function updateEmailTestRecipient(client: PoolClient, input: {
  actorUserId: string;
  recipientId: string;
  action: EmailRecipientAction;
  request: Request;
  environment?: Environment;
  now?: Date;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const row = await recipientById(client,input.recipientId,true);
  const nextStatus = input.action === "enable" ? "active" : "disabled";
  if (!row.verified_at || !["active","disabled"].includes(row.status)) {
    throw new ResearchApiError("TEST_RECIPIENT_NOT_VERIFIED", "只有已验证地址可以启用或停用", 409);
  }
  const auditAction = `maintenance.email_recipient_${input.action === "enable" ? "enabled" : "disabled"}`;
  const reason = automaticAuditReason(auditAction);
  await client.query(`UPDATE notification_email_test_recipients
    SET status=$2,updated_by_user_id=$3,reason=$4,
        revoked_at=CASE WHEN $2::text='disabled' THEN $5::timestamptz ELSE NULL::timestamptz END,
        updated_at=$5,version=version+1
    WHERE id=$1`, [row.id,nextStatus,input.actorUserId,reason,now]);
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: auditAction,
    subjectType: "notification_email_test_recipient",
    subjectId: row.id,
    ...maintenanceCorrelation(input.request),
  });
  return { recipient: await projectRecipient(await recipientById(client,row.id),environment) };
}

export async function deleteEmailTestRecipient(client: PoolClient, input: {
  actorUserId: string;
  recipientId: string;
  request: Request;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const row = await recipientById(client,input.recipientId,true);
  const auditAction = "maintenance.email_recipient_deleted";
  const reason = automaticAuditReason(auditAction);
  await client.query(`UPDATE notification_email_test_recipients
    SET status='deleted',recipient_ciphertext=NULL,verification_code_hash=NULL,
        verification_expires_at=NULL,verification_attempts=0,deleted_at=$3,
        revoked_at=$3,updated_by_user_id=$2,reason=$4,updated_at=$3,version=version+1
    WHERE id=$1`, [row.id,input.actorUserId,now,reason]);
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: auditAction,
    subjectType: "notification_email_test_recipient",
    subjectId: row.id,
    ...maintenanceCorrelation(input.request),
  });
  return { deleted: true, recipientId: row.id };
}
