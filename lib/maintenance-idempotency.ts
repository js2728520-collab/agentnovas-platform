import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { canonicalPayloadHash } from "./commercial-idempotency.ts";
import { ResearchApiError } from "./research-errors.ts";

const MAINTENANCE_IDEMPOTENCY_OPERATIONS = new Set([
  "maintenance.source_integration.test",
  "maintenance.trading.emergency_stop",
  "maintenance.work_records.export",
] as const);

/** 供测试断言应用层枚举与数据库 CHECK allowlist 同步，不参与运行时逻辑。 */
export const MAINTENANCE_IDEMPOTENCY_OPERATIONS_FOR_TEST: readonly string[] =
  [...MAINTENANCE_IDEMPOTENCY_OPERATIONS];

export type MaintenanceIdempotencyOperation =
  | "maintenance.source_integration.test"
  | "maintenance.trading.emergency_stop"
  | "maintenance.work_records.export";

export type MaintenanceIdempotencyDescriptor = {
  operation: MaintenanceIdempotencyOperation;
  actorUserId: string;
  subjectType: string;
  subjectId: string;
  idempotencyKey: string;
  payload: unknown;
  requestId?: string | null;
  traceId?: string | null;
};

type TerminalStatus = "succeeded" | "failed";

type TerminalCommandResult<T> = {
  terminalStatus: TerminalStatus;
  responseStatus: number;
  response: T;
  errorCode?: string | null;
};

type IdempotencyRow = {
  id: string;
  actor_user_id: string;
  subject_type: string;
  subject_id: string;
  canonical_payload_sha256: string;
  status: "processing" | TerminalStatus;
  response_status: number | null;
  response_json: unknown;
  error_code: string | null;
  expired?: boolean;
};

export function maintenanceIdempotencyOperation(value: string): MaintenanceIdempotencyOperation {
  if (!MAINTENANCE_IDEMPOTENCY_OPERATIONS.has(value as MaintenanceIdempotencyOperation)) {
    throw new Error("Unsupported Maintenance idempotency operation");
  }
  return value as MaintenanceIdempotencyOperation;
}

export function maintenanceIdempotencyKeyHash(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new ResearchApiError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "必须提供有效的 Idempotency-Key 请求头",
      422,
      { fields: ["Idempotency-Key"] },
    );
  }
  return createHash("sha256").update(key).digest("hex");
}

function boundedIdentity(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`Invalid Maintenance idempotency ${label}`);
  return normalized;
}

function descriptorBinding(input: MaintenanceIdempotencyDescriptor) {
  return {
    operation: maintenanceIdempotencyOperation(input.operation),
    actorUserId: boundedIdentity(input.actorUserId, "actor", 160),
    subjectType: boundedIdentity(input.subjectType, "subject type", 120),
    subjectId: boundedIdentity(input.subjectId, "subject id", 200),
    keyHash: maintenanceIdempotencyKeyHash(input.idempotencyKey),
    payloadHash: canonicalPayloadHash(input.payload),
  };
}

function terminalResult(row: IdempotencyRow, replayed: boolean) {
  return {
    replayed,
    terminalStatus: row.status as TerminalStatus,
    responseStatus: Number(row.response_status),
    response: row.response_json,
    errorCode: row.error_code,
  };
}

export async function claimMaintenanceIdempotency(pool: Pool, input: MaintenanceIdempotencyDescriptor) {
  const binding = descriptorBinding(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO maintenance_idempotency_records(
        id,operation,actor_user_id,idempotency_key_hash,subject_type,subject_id,
        canonical_payload_sha256,request_id,trace_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(operation,actor_user_id,idempotency_key_hash) DO NOTHING
      RETURNING id
    `, [
      crypto.randomUUID(), binding.operation, binding.actorUserId, binding.keyHash,
      binding.subjectType, binding.subjectId, binding.payloadHash,
      input.requestId?.trim().slice(0, 128) || null,
      input.traceId?.trim().slice(0, 128) || null,
    ]);
    const result = await client.query<IdempotencyRow>(`
      SELECT id,actor_user_id,subject_type,subject_id,canonical_payload_sha256,
             status,response_status,response_json,error_code,(expires_at <= now()) AS expired
        FROM maintenance_idempotency_records
       WHERE operation=$1 AND actor_user_id=$2 AND idempotency_key_hash=$3
       FOR UPDATE
    `, [binding.operation, binding.actorUserId, binding.keyHash]);
    const row = result.rows[0];
    const matches = row
      && row.actor_user_id === binding.actorUserId
      && row.subject_type === binding.subjectType
      && row.subject_id === binding.subjectId
      && row.canonical_payload_sha256 === binding.payloadHash;
    if (!matches) {
      throw new ResearchApiError(
        "IDEMPOTENCY_KEY_COLLISION",
        "Idempotency-Key 已绑定其他 Maintenance 操作",
        409,
      );
    }
    let claim;
    if (inserted.rowCount) {
      claim = { kind: "claimed" as const, id: row.id };
    } else if (row.status === "processing" && row.expired) {
      const reconciled = await completeMaintenanceIdempotency(client, row.id, {
        terminalStatus: "failed",
        responseStatus: 409,
        errorCode: "MAINTENANCE_RECONCILIATION_REQUIRED",
        response: {
          status: "failed",
          errorCode: "MAINTENANCE_RECONCILIATION_REQUIRED",
          message: "上一次 Maintenance 操作的结果未知，需要人工核对；系统不会自动重复执行",
        },
      });
      await client.query(`
        INSERT INTO audit_logs(
          id,actor_user_id,action,subject_type,subject_id,after_json,
          request_id,trace_id,error_code,created_at
        ) VALUES($1,$2,'maintenance.idempotency.reconciliation_required',$3,$4,$5,$6,$7,$8,now())
      `, [
        crypto.randomUUID(),
        binding.actorUserId,
        binding.subjectType,
        binding.subjectId,
        JSON.stringify({ operation: binding.operation, status: "failed", automaticReplay: false }),
        input.requestId?.trim().slice(0, 128) || null,
        input.traceId?.trim().slice(0, 128) || null,
        "MAINTENANCE_RECONCILIATION_REQUIRED",
      ]);
      claim = { kind: "terminal" as const, id: row.id, result: terminalResult(reconciled, true) };
    } else if (row.status === "processing") {
      claim = { kind: "processing" as const, id: row.id };
    } else {
      claim = { kind: "terminal" as const, id: row.id, result: terminalResult(row, true) };
    }
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeMaintenanceIdempotency<T>(
  client: PoolClient,
  id: string,
  result: TerminalCommandResult<T>,
) {
  if (!Number.isInteger(result.responseStatus) || result.responseStatus < 200 || result.responseStatus > 599) {
    throw new Error("Invalid Maintenance idempotency response status");
  }
  const updated = await client.query<IdempotencyRow>(`
    UPDATE maintenance_idempotency_records
       SET status=$2,response_status=$3,response_json=$4::jsonb,error_code=$5,
           completed_at=now(),updated_at=now()
     WHERE id=$1 AND status='processing'
     RETURNING id,actor_user_id,subject_type,subject_id,canonical_payload_sha256,
               status,response_status,response_json,error_code
  `, [
    id,
    result.terminalStatus,
    result.responseStatus,
    JSON.stringify(result.response),
    result.errorCode?.trim().slice(0, 120) || null,
  ]);
  if (updated.rowCount !== 1) throw new Error("Maintenance idempotency command is no longer processing");
  return updated.rows[0];
}

export async function runMaintenanceIdempotentCommand<T>(
  pool: Pool,
  descriptor: MaintenanceIdempotencyDescriptor,
  command: (client: PoolClient) => Promise<TerminalCommandResult<T>>,
) {
  const claim = await claimMaintenanceIdempotency(pool, descriptor);
  if (claim.kind === "terminal") return claim.result as ReturnType<typeof terminalResult> & { response: T };
  if (claim.kind === "processing") {
    throw new ResearchApiError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      "相同 Idempotency-Key 的 Maintenance 操作正在处理中",
      409,
      { retryable: true },
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await command(client);
    const row = await completeMaintenanceIdempotency(client, claim.id, result);
    await client.query("COMMIT");
    return terminalResult(row, false) as ReturnType<typeof terminalResult> & { response: T };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function runMaintenanceIdempotentExternalCommand<T>(
  pool: Pool,
  descriptor: MaintenanceIdempotencyDescriptor,
  command: () => Promise<TerminalCommandResult<T> & { finalize?: (client: PoolClient) => Promise<void> }>,
) {
  const claim = await claimMaintenanceIdempotency(pool, descriptor);
  if (claim.kind === "terminal") return claim.result as ReturnType<typeof terminalResult> & { response: T };
  if (claim.kind === "processing") {
    throw new ResearchApiError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      "相同 Idempotency-Key 的 Maintenance 操作正在处理中",
      409,
      { retryable: true },
    );
  }

  // The external call intentionally runs without a database transaction or pooled
  // client. If the process exits after the provider responds, the durable claim
  // expires into a reconciliation-required terminal failure and is never retried.
  const result = await command();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await result.finalize?.(client);
    const row = await completeMaintenanceIdempotency(client, claim.id, {
      terminalStatus: result.terminalStatus,
      responseStatus: result.responseStatus,
      response: result.response,
      errorCode: result.errorCode,
    });
    await client.query("COMMIT");
    return terminalResult(row, false) as ReturnType<typeof terminalResult> & { response: T };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
