import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import type { PaymentSecretEnvelope, PaymentSecretOperation } from "../packages/payments/src/udun-service-management.ts";
import { maintenanceCorrelation, recordMaintenanceAudit } from "./maintenance-audit.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type Environment = Record<string, string | undefined>;

type SecretRequestRow = {
  id: string;
  operation: PaymentSecretOperation;
  key_id: string;
  envelope_json: PaymentSecretEnvelope | string;
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

function maskOperator(value: string | null) {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at <= 0) return "••••••••";
  return `${value[0]}•••@${value.slice(at + 1)}`;
}

export function safePaymentSecretRequest(row: SecretRequestRow | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    operation: row.operation,
    status: row.status,
    keyId: row.key_id,
    requestedBy: maskOperator(row.requested_by_email),
    requestedAt: iso(row.created_at),
    appliedAt: iso(row.applied_at),
    failedAt: iso(row.failed_at),
    updatedAt: iso(row.updated_at),
    configurationVersion: row.configuration_version,
    configurationFingerprint: row.configuration_fingerprint,
    errorCode: row.error_code,
  };
}

export async function paymentSecretBrokerPublicConfiguration(environment: Environment = process.env) {
  const keyId = environment.PAYMENT_SECRET_BROKER_KEY_ID?.trim() ?? "";
  const path = environment.PAYMENT_SECRET_BROKER_PUBLIC_KEY_PATH?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(keyId) || !path) return null;
  try {
    const raw = await readFile(/* turbopackIgnore: true */ path, "utf8");
    if (raw.length < 300 || raw.length > 8_192) return null;
    return { keyId, publicKeyPem: createPublicKey(raw).export({ type: "spki", format: "pem" }).toString() };
  } catch { return null; }
}

async function secretRequest(queryable: Queryable, id?: string) {
  const params = id ? [id] : [];
  const where = id ? "WHERE request.id=$1" : "";
  const result = await queryable.query<SecretRequestRow>(`
    SELECT request.id,request.operation,request.key_id,request.envelope_json,request.status,
      request.requested_by_user_id,request.reason,request.request_id,request.trace_id,
      request.claimed_by,request.lease_expires_at,request.configuration_version,
      request.configuration_fingerprint,request.error_code,request.created_at,
      request.applied_at,request.failed_at,request.updated_at,requester.email AS requested_by_email
    FROM payment_secret_requests AS request
    LEFT JOIN users AS requester ON requester.id=request.requested_by_user_id
    ${where} ORDER BY request.created_at DESC,request.id DESC LIMIT 1
  `, params);
  return result.rows[0];
}

export async function loadPaymentSecretManagementStatus(queryable: Queryable, environment: Environment = process.env, now = new Date()) {
  const [configuration, latest, heartbeatResult] = await Promise.all([
    paymentSecretBrokerPublicConfiguration(environment),
    secretRequest(queryable),
    queryable.query<{ status: string; heartbeat_at: Date | string; last_error_code: string | null }>(`
      SELECT status,heartbeat_at,last_error_code FROM payment_secret_broker_heartbeats
      ORDER BY heartbeat_at DESC NULLS LAST LIMIT 1
    `),
  ]);
  const heartbeat = heartbeatResult.rows[0];
  const heartbeatAt = iso(heartbeat?.heartbeat_at);
  const available = Boolean(configuration && heartbeatAt && heartbeat?.status === "running"
    && now.getTime() - Date.parse(heartbeatAt) <= 90_000);
  return {
    browserConfigurable: available,
    broker: { available, keyId: configuration?.keyId ?? null, heartbeatAt, lastErrorCode: heartbeat?.last_error_code ?? null },
    latestRequest: safePaymentSecretRequest(latest),
  };
}

export async function loadPaymentSecretRequest(queryable: Queryable, id: string) {
  if (!/^[A-Za-z0-9-]{8,160}$/.test(id)) throw new ResearchApiError("NOT_FOUND", "支付配置请求不存在", 404);
  const request = safePaymentSecretRequest(await secretRequest(queryable, id));
  if (!request) throw new ResearchApiError("NOT_FOUND", "支付配置请求不存在", 404);
  return { request };
}

export async function createPaymentSecretRequest(client: PoolClient, input: {
  actorUserId: string;
  operation: PaymentSecretOperation;
  envelope: PaymentSecretEnvelope;
  reason: string;
  request: Request;
  environment?: Environment;
}) {
  const configuration = await paymentSecretBrokerPublicConfiguration(input.environment ?? process.env);
  if (!configuration) throw new ResearchApiError("PAYMENT_SECRET_BROKER_NOT_CONFIGURED", "支付密钥 Broker 尚未配置", 503);
  if (configuration.keyId !== input.envelope.keyId) {
    throw new ResearchApiError("PAYMENT_SECRET_KEY_ID_STALE", "Broker 公钥已经轮换，请刷新后重试", 409);
  }
  const applying = await client.query(`SELECT id FROM payment_secret_requests
    WHERE status='applying' AND lease_expires_at>now() LIMIT 1 FOR SHARE`);
  if (applying.rows.length) throw new ResearchApiError("PAYMENT_SECRET_REQUEST_IN_PROGRESS", "已有支付配置请求正在应用", 409);
  await client.query(`UPDATE payment_secret_requests SET status='superseded',updated_at=now() WHERE status='pending'`);
  const id = crypto.randomUUID();
  const correlation = maintenanceCorrelation(input.request);
  await client.query(`INSERT INTO payment_secret_requests(
    id,operation,key_id,envelope_json,status,requested_by_user_id,reason,request_id,trace_id
  ) VALUES($1,$2,$3,$4::jsonb,'pending',$5,$6,$7,$8)`, [
    id, input.operation, input.envelope.keyId, JSON.stringify(input.envelope), input.actorUserId,
    input.reason, correlation.requestId, correlation.traceId,
  ]);
  await recordMaintenanceAudit(client, {
    actorUserId: input.actorUserId,
    action: `maintenance.payment_secret.${input.operation}_requested`,
    subjectType: "payment_secret_request", subjectId: id, reason: input.reason, ...correlation,
  });
  return { request: safePaymentSecretRequest(await secretRequest(client, id)) };
}

export async function claimPaymentSecretRequest(pool: Pool, input: { workerId: string; now: Date; leaseSeconds?: number }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<SecretRequestRow>(`
      WITH candidate AS (
        SELECT id FROM payment_secret_requests
        WHERE status='pending' OR (status='applying' AND lease_expires_at<=$2)
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE payment_secret_requests AS request
      SET status='applying',claimed_by=$1,lease_expires_at=$2::timestamptz+($3*interval '1 second'),updated_at=$2
      FROM candidate WHERE request.id=candidate.id RETURNING request.*
    `, [input.workerId, input.now, input.leaseSeconds ?? 60]);
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id, operation: row.operation, keyId: row.key_id,
      envelope: typeof row.envelope_json === "string" ? JSON.parse(row.envelope_json) : row.envelope_json,
      requestedAt: iso(row.created_at)!,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function completePaymentSecretRequest(pool: Pool, input: {
  requestId: string; workerId: string; version: string; fingerprint: string; now: Date;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`UPDATE payment_secret_requests
      SET status='applied',configuration_version=$3,configuration_fingerprint=$4,
        applied_at=$5,failed_at=NULL,error_code=NULL,lease_expires_at=NULL,updated_at=$5
      WHERE id=$1 AND status='applying' AND claimed_by=$2 RETURNING id`,
    [input.requestId, input.workerId, input.version, input.fingerprint, input.now]);
    if (result.rowCount !== 1) { await client.query("ROLLBACK"); return false; }
    await client.query(`UPDATE payment_provider_configs SET
      secret_configuration_version=$1,secret_configuration_fingerprint=$2,
      last_test_at=NULL,last_test_status=NULL,last_test_configuration_version=NULL,last_error_code=NULL,
      last_callback_test_at=NULL,last_callback_test_status=NULL,last_callback_test_configuration_version=NULL,
      last_callback_error_code=NULL,updated_at=$3
      WHERE provider='udun'`, [input.version, input.fingerprint, input.now]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function failPaymentSecretRequest(queryable: Queryable, input: {
  requestId: string; workerId: string; errorCode: string; now: Date;
}) {
  const errorCode = /^[A-Z0-9_:-]{1,80}$/.test(input.errorCode) ? input.errorCode : "PAYMENT_SECRET_APPLY_FAILED";
  const result = await queryable.query(`UPDATE payment_secret_requests
    SET status='failed',failed_at=$4,error_code=$3,lease_expires_at=NULL,updated_at=$4
    WHERE id=$1 AND status='applying' AND claimed_by=$2 RETURNING id`,
  [input.requestId, input.workerId, errorCode, input.now]);
  return result.rowCount === 1;
}

export async function recordPaymentSecretBrokerHeartbeat(queryable: Queryable, input: {
  instanceId: string;
  status: "starting" | "running" | "stopping" | "stopped" | "error";
  commitSha?: string | null;
  currentRequestId?: string | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  lastErrorCode?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const errorCode = input.lastErrorCode && /^[A-Z0-9_:-]{1,80}$/.test(input.lastErrorCode) ? input.lastErrorCode : null;
  await queryable.query(`INSERT INTO payment_secret_broker_heartbeats(
    instance_id,status,commit_sha,current_request_id,last_success_at,last_failure_at,last_error_code,
    heartbeat_at,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
  ON CONFLICT(instance_id) DO UPDATE SET
    status=EXCLUDED.status,commit_sha=COALESCE(EXCLUDED.commit_sha,payment_secret_broker_heartbeats.commit_sha),
    current_request_id=EXCLUDED.current_request_id,
    last_success_at=COALESCE(EXCLUDED.last_success_at,payment_secret_broker_heartbeats.last_success_at),
    last_failure_at=COALESCE(EXCLUDED.last_failure_at,payment_secret_broker_heartbeats.last_failure_at),
    last_error_code=CASE WHEN EXCLUDED.last_failure_at IS NOT NULL THEN EXCLUDED.last_error_code
      WHEN EXCLUDED.last_success_at IS NOT NULL THEN NULL ELSE payment_secret_broker_heartbeats.last_error_code END,
    heartbeat_at=EXCLUDED.heartbeat_at,updated_at=EXCLUDED.updated_at`, [
      input.instanceId, input.status, input.commitSha?.slice(0, 80) || null,
      input.currentRequestId?.slice(0, 160) || null, input.lastSuccessAt ?? null,
      input.lastFailureAt ?? null, errorCode, now,
    ]);
}
