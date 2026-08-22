import type { Pool, PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

type AuthorizeCustomer = (client: PoolClient, customerId: string) => Promise<void>;

function normalizeDelta(value: string) {
  if (!/^-?[1-9]\d{0,11}$/.test(value.trim())) throw new ResearchApiError("CREDIT_DELTA_INVALID", "Credits 调整数必须为非零整数且绝对值不超过 999,999,999,999", 422);
  const delta = BigInt(value.trim());
  const maximum = BigInt("999999999999");
  if (delta === BigInt(0) || delta > maximum || delta < -maximum) throw new ResearchApiError("CREDIT_DELTA_INVALID", "Credits 调整数超出允许范围", 422);
  return delta;
}

function bounded(value: string, minimum: number, maximum: number, code: string, message: string) {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new ResearchApiError(code, message, 422);
  return normalized;
}

function requestNumber(now: Date) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `CA-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function submitCreditAdjustment(pool: Pool, input: {
  actorUserId: string;
  customerId: string;
  amountDelta: string;
  reason: string;
  evidenceReference: string;
  idempotencyKey: string;
  requestId: string;
  authorize: AuthorizeCustomer;
  now?: Date;
}) {
  const amountDelta = normalizeDelta(input.amountDelta);
  const reason = bounded(input.reason, 3, 500, "CREDIT_REASON_INVALID", "调整原因需要 3–500 个字符");
  const evidenceReference = input.evidenceReference.trim();
  if (evidenceReference.length > 500) throw new ResearchApiError("CREDIT_EVIDENCE_INVALID", "凭证引用不能超过 500 个字符", 422);
  const idempotencyKey = bounded(input.idempotencyKey, 8, 160, "IDEMPOTENCY_KEY_INVALID", "幂等键需要 8–160 个字符");
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = (await client.query(`
      SELECT id,request_no,user_id,amount_delta::text,reason,evidence_reference,status,requested_at
        FROM ai_credit_adjustment_requests
       WHERE requested_by_user_id=$1 AND idempotency_key=$2
       FOR UPDATE
    `, [input.actorUserId, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.user_id !== input.customerId || existing.amount_delta !== amountDelta.toString() || existing.reason !== reason || existing.evidence_reference !== evidenceReference) {
        throw new ResearchApiError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同的 Credits 调整内容", 409);
      }
      await client.query("COMMIT");
      return { id: existing.id, requestNo: existing.request_no, status: existing.status, amountDelta: existing.amount_delta, requestedAt: new Date(existing.requested_at).toISOString(), replayed: true };
    }
    await input.authorize(client, input.customerId);
    const account = (await client.query("SELECT id FROM ai_credit_accounts WHERE user_id=$1 FOR SHARE", [input.customerId])).rows[0];
    const id = crypto.randomUUID();
    const requestNo = requestNumber(now);
    try {
      await client.query(`
        INSERT INTO ai_credit_adjustment_requests(
          id,request_no,user_id,account_id,amount_delta,reason,evidence_reference,status,
          requested_by_user_id,request_id,idempotency_key,requested_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$11)
      `, [id, requestNo, input.customerId, account?.id ?? null, amountDelta.toString(), reason, evidenceReference, input.actorUserId, input.requestId, idempotencyKey, now]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ResearchApiError("CREDIT_ADJUSTMENT_PENDING", "该客户已有待复核的 Credits 调整申请", 409);
      throw error;
    }
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at)
      VALUES($1,$2,'credits.adjustment_requested','credit_adjustment',$3,$4::jsonb,$5)
    `, [crypto.randomUUID(), input.actorUserId, id, JSON.stringify({ customerId: input.customerId, amountDelta: amountDelta.toString(), reason, evidenceReference, requestId: input.requestId }), now]);
    await client.query("COMMIT");
    return { id, requestNo, status: "pending", amountDelta: amountDelta.toString(), requestedAt: now.toISOString(), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function decideCreditAdjustment(pool: Pool, input: {
  actorUserId: string;
  adjustmentId: string;
  decision: "approve" | "reject";
  note: string;
  idempotencyKey: string;
  requestId: string;
  authorize: AuthorizeCustomer;
  now?: Date;
}) {
  const note = bounded(input.note, 3, 500, "CREDIT_DECISION_NOTE_INVALID", "复核说明需要 3–500 个字符");
  const idempotencyKey = bounded(input.idempotencyKey, 8, 160, "IDEMPOTENCY_KEY_INVALID", "幂等键需要 8–160 个字符");
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = (await client.query(`
      SELECT decision.request_id,decision.reviewer_user_id,decision.decision,request.status
        FROM ai_credit_adjustment_decisions decision
        JOIN ai_credit_adjustment_requests request ON request.id=decision.request_id
       WHERE decision.idempotency_key=$1 FOR SHARE
    `, [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.request_id !== input.adjustmentId || replay.reviewer_user_id !== input.actorUserId || replay.decision !== input.decision) throw new ResearchApiError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同的 Credits 审批内容", 409);
      await client.query("COMMIT");
      return { id: input.adjustmentId, status: replay.status, replayed: true };
    }
    const adjustment = (await client.query(`
      SELECT id,user_id,account_id,amount_delta::text,status,requested_by_user_id,reason
        FROM ai_credit_adjustment_requests WHERE id=$1 FOR UPDATE
    `, [input.adjustmentId])).rows[0];
    if (!adjustment) throw new ResearchApiError("CREDIT_ADJUSTMENT_NOT_FOUND", "Credits 调整申请不存在", 404);
    await input.authorize(client, adjustment.user_id);
    if (adjustment.requested_by_user_id === input.actorUserId) throw new ResearchApiError("CREDIT_ADJUSTMENT_SELF_REVIEW", "申请人不能复核自己的 Credits 调整", 403);
    if (adjustment.status !== "pending") throw new ResearchApiError("CREDIT_ADJUSTMENT_STATE_CONFLICT", "Credits 调整申请已处理，请刷新队列", 409, { status: adjustment.status });
    const amountDelta = BigInt(adjustment.amount_delta);
    let accountId = adjustment.account_id as string | null;
    let balanceAvailable: bigint | null = null;
    let balanceReserved = BigInt(0);
    if (input.decision === "approve") {
      const account = (await client.query(`SELECT id,available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id=$1 FOR UPDATE`, [adjustment.user_id])).rows[0];
      if (!account) {
        if (amountDelta < BigInt(0)) throw new ResearchApiError("CREDIT_BALANCE_INSUFFICIENT", "客户尚无 Credits 账户，不能执行负向调整", 409);
        accountId = crypto.randomUUID();
        balanceAvailable = amountDelta;
        await client.query(`INSERT INTO ai_credit_accounts(id,user_id,available_credits,reserved_credits,version,updated_at) VALUES($1,$2,$3,0,1,$4)`, [accountId, adjustment.user_id, balanceAvailable.toString(), now]);
      } else {
        accountId = account.id;
        balanceAvailable = BigInt(account.available_credits) + amountDelta;
        balanceReserved = BigInt(account.reserved_credits);
        if (balanceAvailable < BigInt(0)) throw new ResearchApiError("CREDIT_BALANCE_INSUFFICIENT", "Credits 可用余额不足，不能完成负向调整", 409, { available: account.available_credits, requestedDelta: amountDelta.toString() });
        await client.query(`UPDATE ai_credit_accounts SET available_credits=$2,version=version+1,updated_at=$3 WHERE id=$1`, [accountId, balanceAvailable.toString(), now]);
      }
      await client.query(`
        INSERT INTO ai_credit_ledger_entries(
          id,account_id,entry_type,available_delta,reserved_delta,balance_available,balance_reserved,
          source_type,source_id,idempotency_key,request_id,created_by_user_id,created_at
        ) VALUES($1,$2,'adjust',$3,0,$4,$5,'ops_credit_adjustment',$6,$7,$8,$9,$10)
      `, [crypto.randomUUID(), accountId, amountDelta.toString(), balanceAvailable!.toString(), balanceReserved.toString(), adjustment.id, `credit-adjustment:${adjustment.id}`, input.requestId, input.actorUserId, now]);
    }
    await client.query(`INSERT INTO ai_credit_adjustment_decisions(id,request_id,reviewer_user_id,decision,note,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), adjustment.id, input.actorUserId, input.decision, note, idempotencyKey, now]);
    const status = input.decision === "approve" ? "approved" : "rejected";
    await client.query(`UPDATE ai_credit_adjustment_requests SET account_id=$2,status=$3,decided_by_user_id=$4,decision_note=$5,decided_at=$6,updated_at=$6 WHERE id=$1`, [adjustment.id, accountId, status, input.actorUserId, note, now]);
    await client.query(`
      INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key)
      VALUES($1,$2,'in_app','credits',$3,$4::jsonb,'queued',$5,$6) ON CONFLICT(dedupe_key) DO NOTHING
    `, [crypto.randomUUID(), adjustment.user_id, `credits_adjustment_${status}`, JSON.stringify({ requestId: adjustment.id, amountDelta: adjustment.amount_delta, status, note }), now, `credit-adjustment:${adjustment.id}:${status}`]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
      VALUES($1,$2,$3,'credit_adjustment',$4,$5::jsonb,$6::jsonb,$7)
    `, [crypto.randomUUID(), input.actorUserId, `credits.adjustment_${status}`, adjustment.id, JSON.stringify({ status: "pending" }), JSON.stringify({ status, note, amountDelta: adjustment.amount_delta, balanceAvailable: balanceAvailable?.toString() ?? null, requestId: input.requestId }), now]);
    await client.query("COMMIT");
    return { id: adjustment.id, status, amountDelta: adjustment.amount_delta, balanceAvailable: balanceAvailable?.toString() ?? null, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
