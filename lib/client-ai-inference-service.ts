import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  releaseAiCreditReservationInTransaction,
  reserveAiCreditsInTransaction,
  settleAiCreditReservationInTransaction,
} from "./ai-credit-service.ts";
import type { TrustedAiUsage } from "./ai-provider.ts";
import { calculateTokenCost } from "./commercial-membership-domain.ts";
import { canonicalPayloadHash } from "./commercial-idempotency.ts";
import { ResearchApiError } from "./research-errors.ts";

export type ClientAiInferenceOperation = "assistant_message" | "strategy_generation";

type InferenceRow = {
  id: string;
  user_id: string;
  operation: ClientAiInferenceOperation;
  idempotency_key: string;
  payload_sha256: string;
  profile_revision_id: string;
  status: "processing" | "succeeded" | "failed";
  reservation_id: string | null;
  result_json: unknown;
  error_code: string | null;
  error_message: string | null;
  error_status: number | null;
};

type ReconciliationRow = InferenceRow & {
  reservation_status: "reserved" | "settled" | "released";
  reservation_expires_at: Date;
};

const MAXIMUM_INPUT_TOKENS = 128_000;

export function estimatedClientAiCredits(maxOutputTokens: number) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8_000) {
    throw new ResearchApiError("AI_RATE_NOT_RELIABLE", "AI 最大输出用量配置无效", 503);
  }
  return BigInt(calculateTokenCost({
    modelVersion: "token-cost-v1",
    usageReliable: true,
    rateReliable: true,
    inputTokens: MAXIMUM_INPUT_TOKENS,
    outputTokens: maxOutputTokens,
  }).credits);
}

function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new ResearchApiError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "必须提供有效的 Idempotency-Key 请求头",
      422,
      { fields: ["Idempotency-Key"] },
    );
  }
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function replay(row: InferenceRow) {
  if (row.status === "succeeded") return { state: "succeeded" as const, result: row.result_json };
  if (row.status === "failed") {
    throw new ResearchApiError(
      row.error_code || "AI_REQUEST_FAILED",
      row.error_message || "AI 请求未完成，请使用新的请求重试",
      row.error_status || 502,
    );
  }
  throw new ResearchApiError(
    "AI_REQUEST_IN_PROGRESS",
    "相同请求正在处理中，请等待当前请求完成",
    409,
  );
}

async function reconcileStaleClientAiInference(pool: Pool, input: {
  inferenceRequestId: string;
  now: Date;
  requestId: string;
}) {
  return inTransaction(pool, async (client) => {
    const row = (await client.query<ReconciliationRow>(`
      SELECT req.id,req.user_id,req.operation,req.idempotency_key,req.payload_sha256,
             req.profile_revision_id,req.status,req.reservation_id,req.result_json,
             req.error_code,req.error_message,req.error_status,
             reservation.status AS reservation_status,
             reservation.expires_at AS reservation_expires_at
        FROM client_ai_inference_requests AS req
        JOIN ai_credit_reservations AS reservation ON reservation.id=req.reservation_id
       WHERE req.id=$1
       FOR UPDATE OF req,reservation
    `, [input.inferenceRequestId])).rows[0];
    if (!row || row.status !== "processing" || row.reservation_expires_at.getTime() > input.now.getTime()) {
      return { state: "unchanged" as const, row };
    }

    let errorCode: string;
    let errorMessage: string;
    const errorStatus = 409;
    let outcome: "released" | "requires_review";
    if (row.reservation_status === "settled") {
      errorCode = "AI_RECONCILIATION_REQUIRED";
      errorMessage = "AI 请求在结果持久化前中断且 Credits 已结算，需要平台人工核对；相同请求不会再次调用模型";
      outcome = "requires_review";
    } else {
      if (row.reservation_status === "reserved") {
        await releaseAiCreditReservationInTransaction(client, {
          reservationId: row.reservation_id!,
          idempotencyKey: `client-ai:${row.id}:stale-release`,
          requestId: input.requestId,
        });
      }
      errorCode = "AI_REQUEST_STALE_RELEASED";
      errorMessage = "AI 请求执行状态中断，未结算 Credits 已释放；相同请求不会再次调用模型，请使用新的请求重试";
      outcome = "released";
    }
    const updated = await client.query<InferenceRow>(`
      UPDATE client_ai_inference_requests
         SET status='failed',error_code=$2,error_message=$3,error_status=$4,
             completed_at=now(),updated_at=now()
       WHERE id=$1 AND status='processing'
       RETURNING id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,status,
                 reservation_id,result_json,error_code,error_message,error_status
    `, [row.id, errorCode, errorMessage, errorStatus]);
    if (!updated.rows[0]) {
      throw new ResearchApiError("AI_REQUEST_STATE_CONFLICT", "AI 请求清理状态冲突", 409);
    }
    return { state: outcome, row: updated.rows[0] };
  });
}

export async function reconcileExpiredClientAiInferences(pool: Pool, input: {
  userId: string;
  requestId: string;
  now?: Date;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ResearchApiError("AI_RECONCILIATION_TIME_INVALID", "AI 请求清理时间无效", 500);
  }
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ResearchApiError("AI_RECONCILIATION_LIMIT_INVALID", "AI 请求清理数量无效", 500);
  }
  const requestId = input.requestId.trim().slice(0, 160) || randomUUID();
  const candidates = await pool.query<{ id: string }>(`
    SELECT req.id
      FROM client_ai_inference_requests AS req
      JOIN ai_credit_reservations AS reservation ON reservation.id=req.reservation_id
     WHERE req.user_id=$1
       AND req.status='processing'
       AND reservation.expires_at <= $2
     ORDER BY reservation.expires_at,req.id
     LIMIT $3
  `, [input.userId, now.toISOString(), limit]);
  let released = 0;
  let requiresReview = 0;
  for (const candidate of candidates.rows) {
    const result = await reconcileStaleClientAiInference(pool, {
      inferenceRequestId: candidate.id,
      now,
      requestId,
    });
    if (result.state === "released") released += 1;
    if (result.state === "requires_review") requiresReview += 1;
  }
  return { reconciled: released + requiresReview, released, requiresReview };
}

export async function readClientAiInferenceReplay(pool: Pool, input: {
  userId: string;
  operation: ClientAiInferenceOperation;
  idempotencyKey: string;
  payload: unknown;
}) {
  validateIdempotencyKey(input.idempotencyKey);
  let row = (await pool.query<ReconciliationRow>(`
    SELECT request.id,request.user_id,request.operation,request.idempotency_key,
           request.payload_sha256,request.profile_revision_id,request.status,
           request.reservation_id,request.result_json,request.error_code,
           request.error_message,request.error_status,
           reservation.status AS reservation_status,
           reservation.expires_at AS reservation_expires_at
      FROM client_ai_inference_requests AS request
      LEFT JOIN ai_credit_reservations AS reservation ON reservation.id=request.reservation_id
     WHERE request.user_id=$1 AND request.operation=$2 AND request.idempotency_key=$3
     LIMIT 1
  `, [input.userId, input.operation, input.idempotencyKey])).rows[0];
  if (!row) return null;
  if (row.payload_sha256 !== canonicalPayloadHash(input.payload)) {
    throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key 已绑定其他 AI 请求", 409);
  }
  if (row.status === "processing" && row.reservation_expires_at?.getTime() <= Date.now()) {
    const reconciled = await reconcileStaleClientAiInference(pool, {
      inferenceRequestId: row.id,
      now: new Date(),
      requestId: `client-ai:${row.id}:replay-reconcile`,
    });
    if (reconciled.row) row = { ...row, ...reconciled.row };
  }
  return replay(row);
}

export async function beginClientAiInference(pool: Pool, input: {
  userId: string;
  operation: ClientAiInferenceOperation;
  idempotencyKey: string;
  payload: unknown;
  modelRevisionId: string;
  estimatedCredits: bigint;
  requestId: string;
}) {
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.modelRevisionId.trim() || input.modelRevisionId.length > 160) {
    throw new ResearchApiError("PLATFORM_MODEL_NOT_CONFIGURED", "平台模型修订不可用", 503);
  }
  if (input.estimatedCredits <= BigInt(0)) {
    throw new ResearchApiError("AI_RATE_NOT_RELIABLE", "AI Credits 预留费率不可用", 503);
  }
  const payloadHash = canonicalPayloadHash(input.payload);
  try {
    return await inTransaction(pool, async (client) => {
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO client_ai_inference_requests(
          id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,request_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(user_id,operation,idempotency_key) DO NOTHING
        RETURNING id
      `, [id, input.userId, input.operation, input.idempotencyKey, payloadHash, input.modelRevisionId, input.requestId]);
      if (!inserted.rows[0]) {
        const existing = (await client.query<InferenceRow>(`
          SELECT id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,status,
                 reservation_id,result_json,error_code,error_message,error_status
            FROM client_ai_inference_requests
           WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3
           FOR UPDATE
        `, [input.userId, input.operation, input.idempotencyKey])).rows[0];
        if (!existing || existing.payload_sha256 !== payloadHash) {
          throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key 已绑定其他 AI 请求", 409);
        }
        return replay(existing);
      }
      const reserved = await reserveAiCreditsInTransaction(client, {
        userId: input.userId,
        credits: input.estimatedCredits,
        sourceType: "client_ai_inference",
        sourceId: id,
        idempotencyKey: `client-ai:${id}:reserve`,
        requestId: input.requestId,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      await client.query(
        `UPDATE client_ai_inference_requests SET reservation_id=$2,updated_at=now() WHERE id=$1`,
        [id, reserved.reservationId],
      );
      return { state: "started" as const, requestId: id, reservationId: reserved.reservationId };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AI_CREDIT_INSUFFICIENT") {
      throw new ResearchApiError(
        "AI_CREDITS_INSUFFICIENT",
        "AI Credits 余额不足，当前请求未调用模型也未扣费",
        402,
      );
    }
    throw error;
  }
}

export async function completeClientAiInference(pool: Pool, input: {
  requestId: string;
  reservationId: string;
  idempotencyKey: string;
  correlationRequestId: string;
  result?: unknown;
  persistResult?: (client: PoolClient) => Promise<unknown>;
  trustedUsage: TrustedAiUsage;
}) {
  if (
    !input.trustedUsage.providerRequestId.trim()
    || !input.trustedUsage.usageId.trim()
    || input.trustedUsage.providerRequestId !== input.trustedUsage.usageId
  ) {
    throw new ResearchApiError("AI_USAGE_NOT_RELIABLE", "供应商请求与用量标识不可靠", 502);
  }
  return inTransaction(pool, async (client) => {
    const row = (await client.query<InferenceRow>(`
      SELECT id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,status,
             reservation_id,result_json,error_code,error_message,error_status
        FROM client_ai_inference_requests WHERE id=$1 FOR UPDATE
    `, [input.requestId])).rows[0];
    if (!row || row.reservation_id !== input.reservationId || row.idempotency_key !== input.idempotencyKey) {
      throw new ResearchApiError("AI_REQUEST_NOT_FOUND", "AI 请求状态不存在", 404);
    }
    if (row.status === "succeeded") return replay(row);
    if (row.status !== "processing") return replay(row);
    await settleAiCreditReservationInTransaction(client, {
      reservationId: input.reservationId,
      idempotencyKey: `client-ai:${input.requestId}:settle`,
      requestId: input.correlationRequestId,
      costModelVersion: "token-cost-v1",
      trustedUsage: input.trustedUsage,
    });
    const result = input.persistResult
      ? await input.persistResult(client)
      : input.result;
    if (result === undefined) {
      throw new ResearchApiError("AI_RESULT_INVALID", "AI 结果无法持久化", 500);
    }
    const updated = await client.query(`
      UPDATE client_ai_inference_requests
         SET status='succeeded',result_json=$2::jsonb,
             provider_request_id=$3,usage_id=$4,input_tokens=$5,output_tokens=$6,
             completed_at=now(),updated_at=now()
       WHERE id=$1 AND status='processing'
    `, [
      input.requestId,
      JSON.stringify(result),
      input.trustedUsage.providerRequestId,
      input.trustedUsage.usageId,
      input.trustedUsage.inputTokens,
      input.trustedUsage.outputTokens,
    ]);
    if (updated.rowCount !== 1) throw new ResearchApiError("AI_REQUEST_STATE_CONFLICT", "AI 请求状态冲突", 409);
    return { state: "succeeded" as const, result };
  });
}

export async function failClientAiInference(pool: Pool, input: {
  requestId: string;
  reservationId: string;
  idempotencyKey: string;
  correlationRequestId: string;
  errorCode: string;
  errorMessage: string;
  errorStatus: number;
}) {
  const errorCode = input.errorCode.trim().slice(0, 120);
  const errorMessage = input.errorMessage.trim().slice(0, 500);
  if (!errorCode || !errorMessage || !Number.isInteger(input.errorStatus) || input.errorStatus < 400 || input.errorStatus > 599) {
    throw new ResearchApiError("AI_FAILURE_STATE_INVALID", "AI 失败状态无效", 500);
  }
  return inTransaction(pool, async (client) => {
    const row = (await client.query<InferenceRow>(`
      SELECT id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,status,
             reservation_id,result_json,error_code,error_message,error_status
        FROM client_ai_inference_requests WHERE id=$1 FOR UPDATE
    `, [input.requestId])).rows[0];
    if (!row || row.reservation_id !== input.reservationId || row.idempotency_key !== input.idempotencyKey) {
      throw new ResearchApiError("AI_REQUEST_NOT_FOUND", "AI 请求状态不存在", 404);
    }
    if (row.status === "succeeded") return replay(row);
    if (row.status === "failed") {
      if (row.error_code !== errorCode || row.error_message !== errorMessage || row.error_status !== input.errorStatus) {
        throw new ResearchApiError("IDEMPOTENCY_KEY_COLLISION", "AI 失败重放上下文不一致", 409);
      }
      return { state: "failed" as const, created: false };
    }
    await releaseAiCreditReservationInTransaction(client, {
      reservationId: input.reservationId,
      idempotencyKey: `client-ai:${input.requestId}:release`,
      requestId: input.correlationRequestId,
    });
    await client.query(`
      UPDATE client_ai_inference_requests
         SET status='failed',error_code=$2,error_message=$3,error_status=$4,
             completed_at=now(),updated_at=now()
       WHERE id=$1 AND status='processing'
    `, [input.requestId, errorCode, errorMessage, input.errorStatus]);
    return { state: "failed" as const, created: true };
  });
}
