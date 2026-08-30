import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import type { EmailSecretEnvelope, EmailSecretOperation } from "../packages/notifications/src/email-service-management.ts";
import { maskEmailAddress } from "../packages/notifications/src/email-service-management.ts";
import { maintenanceCorrelation, recordMaintenanceAudit } from "./maintenance-audit.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient,"query">;
type Environment = Record<string,string | undefined>;

type SecretRequestRow = {
  id: string;
  operation: EmailSecretOperation;
  key_id: string;
  envelope_json: EmailSecretEnvelope | string;
  status: "pending" | "applying" | "applied" | "failed" | "superseded";
  requested_by_user_id: string;
  requested_by_email: string | null;
  reason: string;
  request_id: string | null;
  trace_id: string | null;
  claimed_by: string | null;
  lease_expires_at: Date | string | null;
  configuration_version: string | null;
  configuration_fingerprint: string | null;
  error_code: string | null;
  created_at: Date | string;
  applied_at: Date | string | null;
  failed_at: Date | string | null;
  updated_at: Date | string;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeRequest(row: SecretRequestRow | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    operation: row.operation,
    status: row.status,
    keyId: row.key_id,
    requestedBy: row.requested_by_email ? maskEmailAddress(row.requested_by_email) : null,
    requestedAt: iso(row.created_at),
    appliedAt: iso(row.applied_at),
    failedAt: iso(row.failed_at),
    updatedAt: iso(row.updated_at),
    configurationVersion: row.configuration_version,
    configurationFingerprint: row.configuration_fingerprint,
    errorCode: row.error_code,
  };
}

export async function emailSecretBrokerPublicConfiguration(environment: Environment = process.env) {
  const keyId = environment.EMAIL_SECRET_BROKER_KEY_ID?.trim() ?? "";
  const path = environment.EMAIL_SECRET_BROKER_PUBLIC_KEY_PATH?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(keyId) || !path) return null;
  try {
    const raw = await readFile(/* turbopackIgnore: true */ path,"utf8");
    if (raw.length < 300 || raw.length > 8_192) return null;
    const publicKeyPem = createPublicKey(raw).export({ type: "spki",format: "pem" }).toString();
    return { keyId,publicKeyPem };
  } catch {
    return null;
  }
}

async function latestSecretRequest(queryable: Queryable) {
  const result = await queryable.query<SecretRequestRow>(`
    SELECT request.id,request.operation,request.key_id,request.envelope_json,
           request.status,request.requested_by_user_id,request.reason,request.request_id,
           request.trace_id,request.claimed_by,request.lease_expires_at,
           request.configuration_version,request.configuration_fingerprint,
           request.error_code,request.created_at,request.applied_at,request.failed_at,
           request.updated_at,requester.email AS requested_by_email
      FROM notification_email_secret_requests AS request
      LEFT JOIN users AS requester ON requester.id=request.requested_by_user_id
     ORDER BY request.created_at DESC,request.id DESC LIMIT 1
  `);
  return result.rows[0];
}

export async function loadEmailSecretManagementStatus(
  queryable: Queryable,
  environment: Environment = process.env,
  now = new Date(),
) {
  const [configuration,latest,workerResult] = await Promise.all([
    emailSecretBrokerPublicConfiguration(environment),
    latestSecretRequest(queryable),
    queryable.query<{ status: string;heartbeat_at: Date | string;last_error_code: string | null }>(`
      SELECT status,heartbeat_at,last_error_code FROM notification_email_secret_broker_heartbeats
       ORDER BY heartbeat_at DESC NULLS LAST LIMIT 1
    `),
  ]);
  const worker = workerResult.rows[0];
  const heartbeatAt = iso(worker?.heartbeat_at);
  const workerAvailable = Boolean(heartbeatAt && worker?.status === "running"
    && now.getTime()-Date.parse(heartbeatAt) <= 60_000);
  return {
    browserConfigurable: Boolean(configuration && workerAvailable),
    broker: {
      available: workerAvailable,
      keyId: configuration?.keyId ?? null,
      publicKeyPem: configuration?.publicKeyPem ?? null,
      heartbeatAt,
      lastErrorCode: worker?.last_error_code ?? null,
    },
    latestRequest: safeRequest(latest),
  };
}

export async function createEmailSecretRequest(client: PoolClient,input: {
  actorUserId: string;
  operation: EmailSecretOperation;
  envelope: EmailSecretEnvelope;
  reason: string;
  request: Request;
  environment?: Environment;
}) {
  const configuration = await emailSecretBrokerPublicConfiguration(input.environment ?? process.env);
  if (!configuration) throw new ResearchApiError("EMAIL_SECRET_BROKER_NOT_CONFIGURED","邮件密钥 Broker 尚未配置",503);
  if (configuration.keyId !== input.envelope.keyId) {
    throw new ResearchApiError("EMAIL_SECRET_KEY_ID_STALE","Broker 公钥已经轮换，请刷新页面后重试",409);
  }
  const applying = await client.query(`SELECT id FROM notification_email_secret_requests
    WHERE status='applying' AND lease_expires_at>now() LIMIT 1 FOR SHARE`);
  if (applying.rows.length) throw new ResearchApiError("EMAIL_SECRET_REQUEST_IN_PROGRESS","已有密钥请求正在应用",409);
  await client.query(`UPDATE notification_email_secret_requests
    SET status='superseded',updated_at=now()
    WHERE status='pending'`);
  const id = crypto.randomUUID();
  const correlation = maintenanceCorrelation(input.request);
  await client.query(`INSERT INTO notification_email_secret_requests(
    id,operation,key_id,envelope_json,status,requested_by_user_id,reason,request_id,trace_id
  ) VALUES($1,$2,$3,$4::jsonb,'pending',$5,$6,$7,$8)`,[
    id,input.operation,input.envelope.keyId,JSON.stringify(input.envelope),input.actorUserId,
    input.reason,correlation.requestId,correlation.traceId,
  ]);
  await recordMaintenanceAudit(client,{
    actorUserId: input.actorUserId,
    action: `maintenance.email_secret.${input.operation}_requested`,
    subjectType: "notification_email_secret_request",
    subjectId: id,
    reason: input.reason,
    ...correlation,
  });
  return { request: safeRequest(await latestSecretRequest(client)) };
}

export async function claimEmailSecretRequest(pool: Pool,input: {
  workerId: string;
  now: Date;
  leaseSeconds?: number;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<SecretRequestRow>(`
      WITH candidate AS (
        SELECT id FROM notification_email_secret_requests
         WHERE status='pending' OR (status='applying' AND lease_expires_at<=$2)
         ORDER BY created_at,id
         FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE notification_email_secret_requests AS request
         SET status='applying',claimed_by=$1,
             lease_expires_at=$2::timestamptz+($3*interval '1 second'),updated_at=$2
        FROM candidate WHERE request.id=candidate.id
      RETURNING request.*
    `,[input.workerId,input.now,input.leaseSeconds ?? 60]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    const envelope = typeof row.envelope_json === "string" ? JSON.parse(row.envelope_json) : row.envelope_json;
    return {
      id: row.id,operation: row.operation,keyId: row.key_id,envelope,
      requestedAt: iso(row.created_at)!,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function completeEmailSecretRequest(queryable: Queryable,input: {
  requestId: string;
  workerId: string;
  version: string;
  fingerprint: string;
  now: Date;
}) {
  const result = await queryable.query(`UPDATE notification_email_secret_requests
    SET status='applied',configuration_version=$3,configuration_fingerprint=$4,
        applied_at=$5,failed_at=NULL,error_code=NULL,lease_expires_at=NULL,updated_at=$5
    WHERE id=$1 AND status='applying' AND claimed_by=$2
    RETURNING id`,[input.requestId,input.workerId,input.version,input.fingerprint,input.now]);
  return result.rowCount === 1;
}

export async function failEmailSecretRequest(queryable: Queryable,input: {
  requestId: string;
  workerId: string;
  errorCode: string;
  now: Date;
}) {
  const errorCode = /^[A-Z0-9_:-]{1,80}$/.test(input.errorCode) ? input.errorCode : "EMAIL_SECRET_APPLY_FAILED";
  const result = await queryable.query(`UPDATE notification_email_secret_requests
    SET status='failed',failed_at=$4,error_code=$3,lease_expires_at=NULL,updated_at=$4
    WHERE id=$1 AND status='applying' AND claimed_by=$2 RETURNING id`,
  [input.requestId,input.workerId,errorCode,input.now]);
  return result.rowCount === 1;
}

export async function recordEmailSecretBrokerHeartbeat(queryable: Queryable,input: {
  instanceId: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  commitSha?: string | null;
  currentRequestId?: string | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  lastErrorCode?: string | null;
  now?: Date;
}) {
  const now=input.now ?? new Date();
  const errorCode=input.lastErrorCode && /^[A-Z0-9_:-]{1,80}$/.test(input.lastErrorCode) ? input.lastErrorCode : null;
  await queryable.query(`INSERT INTO notification_email_secret_broker_heartbeats(
    instance_id,status,commit_sha,current_request_id,last_success_at,last_failure_at,last_error_code,
    heartbeat_at,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
  ON CONFLICT(instance_id) DO UPDATE SET
    status=EXCLUDED.status,commit_sha=COALESCE(EXCLUDED.commit_sha,notification_email_secret_broker_heartbeats.commit_sha),
    current_request_id=EXCLUDED.current_request_id,
    last_success_at=COALESCE(EXCLUDED.last_success_at,notification_email_secret_broker_heartbeats.last_success_at),
    last_failure_at=COALESCE(EXCLUDED.last_failure_at,notification_email_secret_broker_heartbeats.last_failure_at),
    last_error_code=CASE WHEN EXCLUDED.last_failure_at IS NOT NULL THEN EXCLUDED.last_error_code
      WHEN EXCLUDED.last_success_at IS NOT NULL THEN NULL ELSE notification_email_secret_broker_heartbeats.last_error_code END,
    heartbeat_at=EXCLUDED.heartbeat_at,updated_at=EXCLUDED.updated_at`,[
      input.instanceId,input.status,input.commitSha?.slice(0,80) || null,input.currentRequestId?.slice(0,160) || null,
      input.lastSuccessAt ?? null,input.lastFailureAt ?? null,errorCode,now,
    ]);
}
