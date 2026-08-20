import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { fingerprintPaymentReference, maskPaymentReference } from "./commercial-api-support.ts";
import { calculateWeeklyPerformanceFee } from "./commercial-membership-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function assertCompleteUtcWeek(start: Date, end: Date, now: Date) {
  if (start.getUTCDay() !== 1 || start.getUTCHours()+start.getUTCMinutes()+start.getUTCSeconds()+start.getUTCMilliseconds() !== 0
    || end.getTime() - start.getTime() !== 7 * 86_400_000 || end > now) {
    throw new ResearchApiError("COMPLETE_UTC_WEEK_REQUIRED", "仅可生成已结束的完整 UTC 周（周一至周一）", 422);
  }
}

export async function generatePerformanceStatement(pool: Pool, input: {
  userId: string; strategyIds: string[]; weekStart: string; weekEnd: string;
  generatedByUserId: string; requestId: string;
}) {
  const start = new Date(input.weekStart); const end = new Date(input.weekEnd);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) throw new ResearchApiError("VALIDATION_ERROR", "周区间无效", 422);
  assertCompleteUtcWeek(start, end, new Date());
  const strategyIds = [...new Set(input.strategyIds)].sort();
  if (strategyIds.length !== 3) throw new ResearchApiError("THREE_PAPER_STRATEGIES_REQUIRED", "必须选择三个 Paper 策略合并结算", 422);
  return transaction(pool, async client => {
    const existing = await client.query(`SELECT * FROM performance_fee_statements WHERE user_id=$1 AND week_start=$2 AND week_end=$3 FOR UPDATE`, [input.userId,start,end]);
    if (existing.rows[0]) return { ...existing.rows[0], replayed: true };
    const blocking = await client.query(`SELECT id FROM performance_fee_statements
      WHERE user_id=$1 AND status IN ('approved','payment_pending') AND week_start < $2 FOR UPDATE`, [input.userId,end]);
    if (blocking.rows[0]) throw new ResearchApiError("UNPAID_STATEMENT_BLOCKS_PERIOD", "存在已批准未付款的前序结算单", 409, { statementId: blocking.rows[0].id });
    const membership = await client.query<{ id: string; plan_version_id: string; performance_fee_bps: number }>(`
      SELECT m.id,cpv.id AS plan_version_id,cpv.performance_fee_bps
      FROM memberships m JOIN commercial_plan_versions cpv ON cpv.id=m.plan_code
      WHERE m.customer_id=$1 AND m.status='active' ORDER BY m.created_at DESC LIMIT 1 FOR SHARE`, [input.userId]);
    if (!membership.rows[0]) throw new ResearchApiError("ACTIVE_COMMERCIAL_MEMBERSHIP_REQUIRED", "客户没有可结算的商业会员权益", 422);
    const deployments = await client.query<{ strategy_id: string }>(`SELECT DISTINCT strategy_id FROM strategy_deployments
      WHERE owner_user_id=$1 AND mode='paper' AND strategy_id=ANY($2::text[])`, [input.userId,strategyIds]);
    if (deployments.rows.length !== 3) throw new ResearchApiError("PAPER_STRATEGY_SCOPE_INVALID", "所选策略不属于客户的 Paper 运行实例", 422);
    const pnl = await client.query<{ week_pnl: string; cumulative_pnl: string }>(`
      SELECT COALESCE(sum(realized_net_pnl_usdt) FILTER (WHERE closed_at >= $3 AND closed_at < $4),0)::text AS week_pnl,
             COALESCE(sum(realized_net_pnl_usdt) FILTER (WHERE closed_at < $4),0)::text AS cumulative_pnl
      FROM commercial_closed_paper_pnl WHERE user_id=$1 AND strategy_id=ANY($2::text[])
    `, [input.userId,strategyIds,start,end]);
    await client.query(`INSERT INTO performance_fee_high_water_marks(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [input.userId]);
    const hwm = await client.query<{ high_water_mark: string }>(`SELECT high_water_mark::text FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE`, [input.userId]);
    const calculation = calculateWeeklyPerformanceFee({ weekNetPnl: pnl.rows[0].week_pnl, cumulativeNetPnl: pnl.rows[0].cumulative_pnl,
      committedHighWaterMark: hwm.rows[0].high_water_mark, feeBps: membership.rows[0].performance_fee_bps });
    const id = randomUUID();
    const result = await client.query(`INSERT INTO performance_fee_statements
      (id,user_id,membership_id,plan_version_id,week_start,week_end,strategy_codes_json,week_net_pnl,cumulative_net_pnl,
       prior_high_water_mark,eligible_profit,loss_carry,fee_bps,fee_amount,generated_by_user_id,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [id,input.userId,membership.rows[0].id,membership.rows[0].plan_version_id,start,end,JSON.stringify(strategyIds),
      calculation.weekNetPnl,calculation.cumulativeNetPnl,calculation.committedHighWaterMark,calculation.eligibleProfit,
      calculation.lossCarry,membership.rows[0].performance_fee_bps,calculation.feeAmount,input.generatedByUserId,input.requestId]);
    return { ...result.rows[0], replayed: false };
  });
}

export async function decidePerformanceAssessment(pool: Pool, input: {
  statementId: string; reviewerUserId: string; decision: "approve"|"reject"; note: string; idempotencyKey: string;
}) {
  return transaction(pool, async client => {
    const prior = await client.query(`SELECT decision FROM performance_fee_decisions WHERE idempotency_key=$1`, [input.idempotencyKey]);
    if (prior.rows[0]) return { status: prior.rows[0].decision === 'approve' ? 'approved' : 'rejected', replayed: true };
    const statement = await client.query<{ status:string;generated_by_user_id:string;fee_amount:string;currency:string }>(`
      SELECT status,generated_by_user_id,fee_amount::text,currency FROM performance_fee_statements WHERE id=$1 FOR UPDATE`, [input.statementId]);
    const row=statement.rows[0]; if (!row) throw new ResearchApiError("STATEMENT_NOT_FOUND","分成结算单不存在",404);
    if (row.status !== 'pending_review') throw new ResearchApiError("STATEMENT_STATE_CONFLICT","结算单已处理",409);
    if (row.generated_by_user_id === input.reviewerUserId) throw new ResearchApiError("MAKER_CHECKER_REQUIRED","生成人与审批人必须不同",403);
    await client.query(`INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,idempotency_key)
      VALUES ($1,$2,'assessment',$3,$4,$5,$6)`,[randomUUID(),input.statementId,input.reviewerUserId,input.decision,input.note.slice(0,500),input.idempotencyKey]);
    if(input.decision==='reject') { await client.query(`UPDATE performance_fee_statements SET status='rejected',updated_at=now() WHERE id=$1`,[input.statementId]); return {status:'rejected',replayed:false}; }
    if(Number(row.fee_amount)===0) { await client.query(`UPDATE performance_fee_statements SET status='no_fee',updated_at=now() WHERE id=$1`,[input.statementId]); return {status:'no_fee',replayed:false}; }
    await client.query(`INSERT INTO performance_fee_receivables(id,statement_id,amount,currency) VALUES ($1,$2,$3,$4)`,[randomUUID(),input.statementId,row.fee_amount,row.currency]);
    await client.query(`UPDATE performance_fee_statements SET status='payment_pending',updated_at=now() WHERE id=$1`,[input.statementId]);
    return {status:'payment_pending',replayed:false};
  });
}

export async function recordPerformancePaymentEvidence(pool: Pool, input: {
  statementId:string;actorUserId:string;evidenceKind:string;providerLabel?:string;reference:string;amount:string;currency:string;occurredAt:string;note?:string;
}) {
  return transaction(pool, async client => {
    const statement=await client.query<{status:string}>(`SELECT status FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,[input.statementId]);
    if(!statement.rows[0]) throw new ResearchApiError("STATEMENT_NOT_FOUND","分成结算单不存在",404);
    if(statement.rows[0].status!=='payment_pending') throw new ResearchApiError("STATEMENT_STATE_CONFLICT","结算单当前不等待付款确认",409);
    const result=await client.query(`INSERT INTO commercial_payment_evidence
      (id,performance_statement_id,evidence_kind,provider_label,reference_masked,reference_fingerprint,amount,currency,occurred_at,note,recorded_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,reference_masked,amount::text,currency,occurred_at,recorded_by_user_id`,
    [randomUUID(),input.statementId,input.evidenceKind,input.providerLabel?.slice(0,80)??null,maskPaymentReference(input.reference),
      fingerprintPaymentReference(input.reference),input.amount,input.currency,input.occurredAt,input.note?.slice(0,500)??'',input.actorUserId]);
    return result.rows[0];
  });
}

export async function decidePerformancePayment(pool: Pool,input:{statementId:string;reviewerUserId:string;decision:'approve'|'reject';note:string;idempotencyKey:string}) {
  return transaction(pool,async client=>{
    const prior=await client.query(`SELECT decision FROM performance_fee_decisions WHERE idempotency_key=$1`,[input.idempotencyKey]);
    if(prior.rows[0]) return {status:prior.rows[0].decision==='approve'?'paid':'payment_pending',replayed:true};
    const statement=await client.query<{status:string;user_id:string;cumulative_net_pnl:string}>(`SELECT status,user_id,cumulative_net_pnl::text FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,[input.statementId]);
    const row=statement.rows[0]; if(!row) throw new ResearchApiError("STATEMENT_NOT_FOUND","分成结算单不存在",404);
    if(row.status!=='payment_pending') throw new ResearchApiError("STATEMENT_STATE_CONFLICT","结算单当前不等待付款确认",409);
    const evidence=await client.query<{id:string;recorded_by_user_id:string}>(`SELECT e.id,e.recorded_by_user_id FROM commercial_payment_evidence e
      JOIN performance_fee_receivables r ON r.statement_id=e.performance_statement_id
      WHERE e.performance_statement_id=$1 AND e.currency=r.currency AND e.amount=r.amount
      ORDER BY e.created_at DESC LIMIT 1 FOR SHARE`,[input.statementId]);
    if(!evidence.rows[0]) throw new ResearchApiError("PAYMENT_EVIDENCE_REQUIRED","请先记录付款凭证",422);
    if(evidence.rows[0].recorded_by_user_id===input.reviewerUserId) throw new ResearchApiError("MAKER_CHECKER_REQUIRED","付款记录人与审批人必须不同",403);
    await client.query(`INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,idempotency_key)
      VALUES($1,$2,'payment',$3,$4,$5,$6)`,[randomUUID(),input.statementId,input.reviewerUserId,input.decision,input.note.slice(0,500),input.idempotencyKey]);
    if(input.decision==='reject') return {status:'payment_pending',replayed:false};
    await client.query(`SELECT 1 FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE`,[row.user_id]);
    await client.query(`UPDATE performance_fee_high_water_marks SET cumulative_net_pnl=$2,
      high_water_mark=GREATEST(high_water_mark,$2::numeric),last_paid_statement_id=$3,version=version+1,updated_at=now() WHERE user_id=$1`,
    [row.user_id,row.cumulative_net_pnl,input.statementId]);
    await client.query(`UPDATE performance_fee_receivables SET status='paid',payment_evidence_id=$2,paid_at=now() WHERE statement_id=$1`,[input.statementId,evidence.rows[0].id]);
    await client.query(`UPDATE performance_fee_statements SET status='paid',updated_at=now() WHERE id=$1`,[input.statementId]);
    return {status:'paid',replayed:false};
  });
}
