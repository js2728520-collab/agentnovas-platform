import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { canonicalPayloadHash } from "./commercial-idempotency.ts";
import { ResearchApiError } from "./research-errors.ts";

export type PlatformDemoAdminOperation = "control" | "verify";

export type PlatformDemoAdminCommand = {
  operation: PlatformDemoAdminOperation;
  idempotencyKey: string;
  actorUserId: string;
  accountId: string;
  action: string;
  strategyCode: string | null;
  reason: string;
  requestId?: string | null;
  traceId?: string | null;
};

type StoredCommand = {
  id: string;
  actor_user_id: string;
  account_id: string;
  action: string;
  strategy_code: string | null;
  reason: string;
  canonical_payload_sha256: string;
  status: "pending" | "succeeded" | "failed";
  response_json: unknown;
  error_code: string | null;
};

function commandPayload(input: PlatformDemoAdminCommand) {
  return {
    accountId: input.accountId,
    action: input.action,
    strategyCode: input.strategyCode,
    reason: input.reason,
  };
}

export async function claimPlatformDemoAdminCommand(
  client: PoolClient,
  input: PlatformDemoAdminCommand,
) {
  const payloadHash = canonicalPayloadHash(commandPayload(input));
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform_demo_admin_commands(
       id,operation,idempotency_key,actor_user_id,account_id,action,
       strategy_code,reason,canonical_payload_sha256,request_id,trace_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(operation,idempotency_key) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      input.operation,
      input.idempotencyKey,
      input.actorUserId,
      input.accountId,
      input.action,
      input.strategyCode,
      input.reason,
      payloadHash,
      input.requestId ?? null,
      input.traceId ?? null,
    ],
  );
  const result = await client.query<StoredCommand>(
    `SELECT id,actor_user_id,account_id,action,strategy_code,reason,
            canonical_payload_sha256,status,response_json,error_code
     FROM platform_demo_admin_commands
     WHERE operation=$1 AND idempotency_key=$2 FOR UPDATE`,
    [input.operation, input.idempotencyKey],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.actor_user_id !== input.actorUserId ||
    row.account_id !== input.accountId ||
    row.action !== input.action ||
    row.strategy_code !== input.strategyCode ||
    row.reason !== input.reason ||
    row.canonical_payload_sha256 !== payloadHash
  ) {
    throw new ResearchApiError(
      "IDEMPOTENCY_KEY_COLLISION",
      "Idempotency-Key 已绑定其他 Demo 管理命令",
      409,
    );
  }
  return {
    id: row.id,
    isNew: inserted.rowCount === 1,
    status: row.status,
    response: row.response_json,
    errorCode: row.error_code,
  };
}

export async function completePlatformDemoAdminCommand(
  client: PoolClient,
  input: {
    id: string;
    status: "succeeded" | "failed";
    response?: unknown;
    errorCode?: string;
  },
) {
  const result = await client.query(
    `UPDATE platform_demo_admin_commands
     SET status=$2,response_json=$3::jsonb,error_code=$4,completed_at=now()
     WHERE id=$1 AND status='pending'`,
    [
      input.id,
      input.status,
      JSON.stringify(input.response ?? null),
      input.errorCode ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new ResearchApiError(
      "DEMO_COMMAND_STATE_CONFLICT",
      "Demo 管理命令已完成或状态已变化",
      409,
    );
  }
}

export function completedPlatformDemoCommandResponse(claim: {
  isNew: boolean;
  status: "pending" | "succeeded" | "failed";
  response: unknown;
}) {
  if (claim.isNew) return null;
  if (claim.status === "succeeded") return claim.response;
  throw new ResearchApiError(
    "DEMO_COMMAND_STATE_CONFLICT",
    claim.status === "pending"
      ? "相同 Demo 管理命令仍在处理中"
      : "相同 Demo 管理命令此前失败，请核对状态后使用新的 Idempotency-Key",
    409,
  );
}
