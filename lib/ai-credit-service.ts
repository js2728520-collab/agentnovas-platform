import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { calculateTokenCost } from "./commercial-membership-domain.ts";
import { canonicalPayloadHash } from "./commercial-idempotency.ts";
import { ResearchApiError } from "./research-errors.ts";

type CreditMutation = "grant" | "reserve" | "settle" | "release" | "adjust";

async function creditTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function mutateAiCredits(
  client: PoolClient,
  input: {
    userId: string;
    type: CreditMutation;
    availableDelta: bigint;
    reservedDelta: bigint;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    requestId: string;
    actorUserId?: string;
    reservationId?: string;
    costModelVersion?: string;
    usage?: Record<string, unknown>;
  },
) {
  const zero = BigInt(0);
  const valid =
    input.type === "grant"
      ? input.availableDelta > zero && input.reservedDelta === zero
      : input.type === "reserve"
        ? input.availableDelta < zero &&
          input.reservedDelta === -input.availableDelta
        : input.type === "settle"
          ? input.availableDelta >= zero &&
            input.reservedDelta < zero &&
            input.availableDelta + input.reservedDelta <= zero
          : input.type === "release"
            ? input.availableDelta > zero &&
              input.reservedDelta === -input.availableDelta
            : input.reservedDelta === zero && input.availableDelta !== zero;
  if (!valid) throw new Error("AI_CREDIT_MUTATION_INVALID");
  const prior = await client.query<{
    id: string;
    balance_available: string;
    balance_reserved: string;
    user_id: string;
    entry_type: string;
    source_type: string;
    source_id: string;
    available_delta: string;
    reserved_delta: string;
    reservation_id: string | null;
    cost_model_version: string | null;
    usage_json: unknown;
    created_by_user_id: string | null;
  }>(
    `SELECT e.id,e.balance_available::text,e.balance_reserved::text,a.user_id,e.entry_type,e.source_type,e.source_id,e.available_delta::text,e.reserved_delta::text,e.reservation_id,e.cost_model_version,e.usage_json,e.created_by_user_id FROM ai_credit_ledger_entries e JOIN ai_credit_accounts a ON a.id=e.account_id WHERE e.idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (prior.rows[0]) {
    const row = prior.rows[0];
    if (
      row.user_id !== input.userId ||
      row.entry_type !== input.type ||
      row.source_type !== input.sourceType ||
      row.source_id !== input.sourceId ||
      BigInt(row.available_delta) !== input.availableDelta ||
      BigInt(row.reserved_delta) !== input.reservedDelta ||
      row.reservation_id !== (input.reservationId ?? null) ||
      row.cost_model_version !== (input.costModelVersion ?? null) ||
      row.created_by_user_id !== (input.actorUserId ?? null) ||
      canonicalPayloadHash(row.usage_json) !==
        canonicalPayloadHash(input.usage ?? null)
    )
      throw new ResearchApiError(
        "IDEMPOTENCY_KEY_COLLISION",
        "Credits 幂等键已绑定其他变更",
        409,
      );
    return {
      entryId: row.id,
      available: row.balance_available,
      reserved: row.balance_reserved,
      created: false,
    };
  }
  await client.query(
    `INSERT INTO ai_credit_accounts (id, user_id) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`,
    [randomUUID(), input.userId],
  );
  const account = await client.query<{
    id: string;
    available_credits: string;
    reserved_credits: string;
  }>(
    `
    SELECT id, available_credits::text, reserved_credits::text FROM ai_credit_accounts WHERE user_id=$1 FOR UPDATE
  `,
    [input.userId],
  );
  if (!account.rows[0]) throw new Error("AI_CREDIT_ACCOUNT_MISSING");
  const available =
    BigInt(account.rows[0].available_credits) + input.availableDelta;
  const reserved =
    BigInt(account.rows[0].reserved_credits) + input.reservedDelta;
  if (available < BigInt(0) || reserved < BigInt(0))
    throw new Error("AI_CREDIT_INSUFFICIENT");
  await client.query(
    `UPDATE ai_credit_accounts SET available_credits=$2, reserved_credits=$3, version=version+1, updated_at=now() WHERE id=$1`,
    [account.rows[0].id, available.toString(), reserved.toString()],
  );
  const entryId = randomUUID();
  await client.query(
    `
    INSERT INTO ai_credit_ledger_entries
      (id,account_id,entry_type,available_delta,reserved_delta,balance_available,balance_reserved,
       source_type,source_id,reservation_id,cost_model_version,usage_json,idempotency_key,request_id,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
  `,
    [
      entryId,
      account.rows[0].id,
      input.type,
      input.availableDelta.toString(),
      input.reservedDelta.toString(),
      available.toString(),
      reserved.toString(),
      input.sourceType,
      input.sourceId,
      input.reservationId ?? null,
      input.costModelVersion ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      input.idempotencyKey,
      input.requestId,
      input.actorUserId ?? null,
    ],
  );
  return {
    entryId,
    available: available.toString(),
    reserved: reserved.toString(),
    created: true,
  };
}

export async function reserveAiCreditsInTransaction(
  client: PoolClient,
  input: {
    userId: string;
    credits: bigint;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    requestId: string;
    expiresAt: string;
    actorUserId?: string;
  },
) {
  if (input.credits <= BigInt(0)) throw new Error("AI_CREDIT_AMOUNT_INVALID");
  const existing = await client.query<{
    id: string;
    user_id: string;
    estimated_credits: string;
    expires_at: Date;
    source_type: string | null;
    source_id: string | null;
    created_by_user_id: string | null;
  }>(
    `SELECT r.id,a.user_id,r.estimated_credits::text,r.expires_at,e.source_type,e.source_id,e.created_by_user_id FROM ai_credit_reservations r JOIN ai_credit_accounts a ON a.id=r.account_id LEFT JOIN ai_credit_ledger_entries e ON e.reservation_id=r.id AND e.entry_type='reserve' WHERE r.idempotency_key=$1 FOR UPDATE OF r`,
    [input.idempotencyKey],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      row.user_id !== input.userId ||
      BigInt(row.estimated_credits) !== input.credits ||
      row.expires_at.toISOString() !==
        new Date(input.expiresAt).toISOString() ||
      row.source_type !== input.sourceType ||
      row.source_id !== input.sourceId ||
      row.created_by_user_id !== (input.actorUserId ?? null)
    )
      throw new ResearchApiError(
        "IDEMPOTENCY_KEY_COLLISION",
        "Credits 预留幂等键已绑定其他变更",
        409,
      );
    return { reservationId: row.id, created: false };
  }
  const account = await client.query<{ id: string }>(
    `SELECT id FROM ai_credit_accounts WHERE user_id=$1`,
    [input.userId],
  );
  if (!account.rows[0]) {
    await client.query(
      `INSERT INTO ai_credit_accounts(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING`,
      [randomUUID(), input.userId],
    );
  }
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM ai_credit_accounts WHERE user_id=$1 FOR UPDATE`,
    [input.userId],
  );
  const reservationId = randomUUID();
  await client.query(
    `INSERT INTO ai_credit_reservations(id,account_id,estimated_credits,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5)`,
    [
      reservationId,
      locked.rows[0].id,
      input.credits.toString(),
      input.idempotencyKey,
      input.expiresAt,
    ],
  );
  await mutateAiCredits(client, {
    userId: input.userId,
    type: "reserve",
    availableDelta: -input.credits,
    reservedDelta: input.credits,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: `${input.idempotencyKey}:ledger`,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    reservationId,
  });
  return { reservationId, created: true };
}

export async function reserveAiCredits(
  pool: Pool,
  input: {
    userId: string;
    credits: bigint;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    requestId: string;
    expiresAt: string;
    actorUserId?: string;
  },
) {
  return creditTransaction(pool, (client) =>
    reserveAiCreditsInTransaction(client, input),
  );
}

export type AiCreditSettlementInput = {
  reservationId: string;
  idempotencyKey: string;
  requestId: string;
  actorUserId?: string;
  costModelVersion: "token-cost-v1";
  trustedUsage: {
    source: "provider_metering";
    providerRequestId?: string;
    usageId: string;
    inputTokens: number;
    outputTokens: number;
  };
};

export async function settleAiCreditReservationInTransaction(
  client: PoolClient,
  input: AiCreditSettlementInput,
) {
  if (
    input.trustedUsage.source !== "provider_metering" ||
    !input.trustedUsage.usageId.trim()
  )
    throw new ResearchApiError(
      "AI_USAGE_NOT_RELIABLE",
      "仅接受供应商计量用量",
      422,
    );
  const cost = calculateTokenCost({
    modelVersion: input.costModelVersion,
    usageReliable: true,
    rateReliable: true,
    inputTokens: input.trustedUsage.inputTokens,
    outputTokens: input.trustedUsage.outputTokens,
  });
  const actualCredits = BigInt(cost.credits);
  const reservation = await client.query<{
    estimated_credits: string;
    status: string;
    user_id: string;
  }>(
    `SELECT r.estimated_credits::text,r.status,a.user_id FROM ai_credit_reservations r JOIN ai_credit_accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE`,
    [input.reservationId],
  );
  const row = reservation.rows[0];
  if (!row)
    throw new ResearchApiError(
      "AI_CREDIT_RESERVATION_NOT_FOUND",
      "Credits 预留不存在",
      404,
    );
  if (row.status === "settled") {
    const prior = await client.query<{
      idempotency_key: string;
      created_by_user_id: string | null;
      cost_model_version: string | null;
      usage_json: unknown;
    }>(
      `SELECT idempotency_key,created_by_user_id,cost_model_version,usage_json FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='settle'`,
      [input.reservationId],
    );
    const expectedUsage = {
      ...input.trustedUsage,
      costModelVersion: cost.modelVersion,
      credits: cost.credits,
    };
    if (
      prior.rows[0]?.idempotency_key !== input.idempotencyKey ||
      prior.rows[0]?.created_by_user_id !== (input.actorUserId ?? null) ||
      prior.rows[0]?.cost_model_version !== input.costModelVersion ||
      canonicalPayloadHash(prior.rows[0]?.usage_json) !==
        canonicalPayloadHash(expectedUsage)
    )
      throw new ResearchApiError(
        "IDEMPOTENCY_KEY_COLLISION",
        "Credits settle 重放上下文不一致",
        409,
      );
    return { reservationId: input.reservationId, created: false };
  }
  if (row.status !== "reserved")
    throw new ResearchApiError(
      "AI_CREDIT_RESERVATION_STATE_CONFLICT",
      "Credits 预留状态冲突",
      409,
    );
  const estimated = BigInt(row.estimated_credits);
  if (actualCredits > estimated)
    throw new ResearchApiError(
      "AI_CREDIT_RESERVATION_EXCEEDED",
      "可信用量成本超过预留，拒绝自动补扣",
      409,
    );
  await mutateAiCredits(client, {
    userId: row.user_id,
    type: "settle",
    availableDelta: estimated - actualCredits,
    reservedDelta: -estimated,
    sourceType: "ai_credit_reservation",
    sourceId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    reservationId: input.reservationId,
    costModelVersion: input.costModelVersion,
    usage: {
      ...input.trustedUsage,
      costModelVersion: cost.modelVersion,
      credits: cost.credits,
    },
  });
  await client.query(
    `UPDATE ai_credit_reservations SET status='settled',settled_credits=$2,version=version+1,updated_at=now() WHERE id=$1`,
    [input.reservationId, actualCredits.toString()],
  );
  return {
    reservationId: input.reservationId,
    created: true,
    settledCredits: cost.credits,
  };
}

export async function settleAiCreditReservation(
  pool: Pool,
  input: AiCreditSettlementInput,
) {
  return creditTransaction(pool, (client) =>
    settleAiCreditReservationInTransaction(client, input),
  );
}

/*
 * Transaction-level helpers are exported so an inference result and its Credits
 * ledger mutation can share one commit. Public callers should normally use the
 * Pool wrappers above and below.
 */
export async function releaseAiCreditReservationInTransaction(
  client: PoolClient,
  input: {
    reservationId: string;
    idempotencyKey: string;
    requestId: string;
    actorUserId?: string;
  },
) {
  const reservation = await client.query<{
    estimated_credits: string;
    status: string;
    user_id: string;
  }>(
    `SELECT r.estimated_credits::text,r.status,a.user_id FROM ai_credit_reservations r JOIN ai_credit_accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE`,
    [input.reservationId],
  );
  const row = reservation.rows[0];
  if (!row)
    throw new ResearchApiError(
      "AI_CREDIT_RESERVATION_NOT_FOUND",
      "Credits 预留不存在",
      404,
    );
  if (row.status === "released") {
    const prior = await client.query<{
      idempotency_key: string;
      created_by_user_id: string | null;
      available_delta: string;
      reserved_delta: string;
      source_type: string;
      source_id: string;
      reservation_id: string | null;
    }>(
      `SELECT idempotency_key,created_by_user_id,available_delta::text,reserved_delta::text,source_type,source_id,reservation_id FROM ai_credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'`,
      [input.reservationId],
    );
    const entry = prior.rows[0],
      credits = BigInt(row.estimated_credits);
    if (
      !entry ||
      entry.idempotency_key !== input.idempotencyKey ||
      entry.created_by_user_id !== (input.actorUserId ?? null) ||
      BigInt(entry.available_delta) !== credits ||
      BigInt(entry.reserved_delta) !== -credits ||
      entry.source_type !== "ai_credit_reservation" ||
      entry.source_id !== input.reservationId ||
      entry.reservation_id !== input.reservationId
    )
      throw new ResearchApiError(
        "IDEMPOTENCY_KEY_COLLISION",
        "Credits release 重放上下文不一致",
        409,
      );
    return { reservationId: input.reservationId, created: false };
  }
  if (row.status !== "reserved")
    throw new ResearchApiError(
      "AI_CREDIT_RESERVATION_STATE_CONFLICT",
      "Credits 预留状态冲突",
      409,
    );
  const credits = BigInt(row.estimated_credits);
  await mutateAiCredits(client, {
    userId: row.user_id,
    type: "release",
    availableDelta: credits,
    reservedDelta: -credits,
    sourceType: "ai_credit_reservation",
    sourceId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    reservationId: input.reservationId,
  });
  await client.query(
    `UPDATE ai_credit_reservations SET status='released',version=version+1,updated_at=now() WHERE id=$1`,
    [input.reservationId],
  );
  return { reservationId: input.reservationId, created: true };
}

export async function releaseAiCreditReservation(
  pool: Pool,
  input: {
    reservationId: string;
    idempotencyKey: string;
    requestId: string;
    actorUserId?: string;
  },
) {
  return creditTransaction(pool, (client) =>
    releaseAiCreditReservationInTransaction(client, input),
  );
}
