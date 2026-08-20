import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { mutateAiCredits } from "./ai-credit-service.ts";
import { fingerprintPaymentReference, maskPaymentReference } from "./commercial-api-support.ts";
import { ensurePlatformLedgerAccount, postCommercialLedgerTransaction } from "./commercial-ledger-service.ts";
import { requiredLegalDocumentTypes } from "./commercial-membership-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
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

export async function createMembershipOrder(pool: Pool, input: {
  userId: string;
  planVersionId: string;
  acceptedDocumentVersionIds: string[];
  idempotencyKey: string;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  return inTransaction(pool, async client => {
    const existing = await client.query(`SELECT * FROM commercial_membership_orders WHERE user_id=$1 AND idempotency_key=$2`, [input.userId, input.idempotencyKey]);
    if (existing.rows[0]) return existing.rows[0];
    const plan = await client.query<{
      id: string; price_amount: string; price_currency: string; duration_days: number | null;
      ai_credit_grant: string; performance_fee_bps: number;
    }>(`SELECT id,price_amount::text,price_currency,duration_days,ai_credit_grant::text,performance_fee_bps
        FROM commercial_plan_versions WHERE id=$1 AND status='active' AND effective_at<=now()`, [input.planVersionId]);
    if (!plan.rows[0]) throw new ResearchApiError("PLAN_NOT_AVAILABLE", "会员计划当前不可购买", 422);
    const legal = await client.query<{ id: string; document_type: string; version: number; content_sha256: string }>(`
      SELECT id,document_type,version,content_sha256 FROM commercial_legal_document_versions
      WHERE id=ANY($1::text[]) AND status='active' AND effective_at<=now()
    `, [input.acceptedDocumentVersionIds]);
    const legalByType = new Map(legal.rows.map(row => [row.document_type, row]));
    if (!requiredLegalDocumentTypes.every(type => legalByType.has(type)) || legal.rows.length !== requiredLegalDocumentTypes.length) {
      throw new ResearchApiError("LEGAL_ACCEPTANCE_REQUIRED", "必须同意当前服务条款、隐私政策和风险披露", 422,
        { requiredDocumentTypes: requiredLegalDocumentTypes });
    }
    for (const document of legal.rows) {
      await client.query(`INSERT INTO commercial_legal_acceptances
        (id,user_id,document_version_id,ip_address,user_agent) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id,document_version_id) DO NOTHING`,
      [randomUUID(), input.userId, document.id, input.ipAddress ?? null, input.userAgent?.slice(0, 512) ?? null]);
    }
    const orderId = randomUUID();
    const planRow = plan.rows[0];
    const legalSnapshot = legal.rows.map(row => ({ id: row.id, type: row.document_type, version: row.version, contentSha256: row.content_sha256 }));
    const orderNo = `MEM-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 8).toUpperCase()}`;
    const result = await client.query(`INSERT INTO commercial_membership_orders
      (id,order_no,user_id,plan_version_id,price_amount,price_currency,duration_days,ai_credit_grant,
       performance_fee_bps,legal_snapshot_json,idempotency_key,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
    [orderId, orderNo, input.userId, planRow.id, planRow.price_amount, planRow.price_currency,
      planRow.duration_days, planRow.ai_credit_grant, planRow.performance_fee_bps,
      JSON.stringify(legalSnapshot), input.idempotencyKey, input.requestId]);
    return result.rows[0];
  });
}

export async function recordMembershipPaymentEvidence(pool: Pool, input: {
  orderId: string; actorUserId: string; evidenceKind: string; providerLabel?: string;
  reference: string; amount: string; currency: string; occurredAt: string; note?: string;
}) {
  if (!input.reference.trim()) throw new ResearchApiError("VALIDATION_ERROR", "付款参考号不能为空", 422);
  return inTransaction(pool, async client => {
    const order = await client.query<{ status: string }>(`SELECT status FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
    if (!order.rows[0]) throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    if (!['pending_evidence','pending_review'].includes(order.rows[0].status)) throw new ResearchApiError("ORDER_STATE_CONFLICT", "当前订单状态不可记录凭证", 409);
    const result = await client.query(`INSERT INTO commercial_payment_evidence
      (id,membership_order_id,evidence_kind,provider_label,reference_masked,reference_fingerprint,amount,currency,occurred_at,note,recorded_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (membership_order_id,reference_fingerprint) DO UPDATE SET membership_order_id=EXCLUDED.membership_order_id
      RETURNING id,membership_order_id,evidence_kind,provider_label,reference_masked,amount::text,currency,occurred_at,note,recorded_by_user_id,created_at`,
    [randomUUID(), input.orderId, input.evidenceKind, input.providerLabel?.slice(0, 80) ?? null,
      maskPaymentReference(input.reference), fingerprintPaymentReference(input.reference), input.amount,
      input.currency, input.occurredAt, input.note?.slice(0, 500) ?? "", input.actorUserId]);
    return result.rows[0];
  });
}

export async function submitMembershipOrder(pool: Pool, orderId: string, actorUserId: string) {
  return inTransaction(pool, async client => {
    const order = await client.query<{ status: string }>(`SELECT status FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`, [orderId]);
    if (!order.rows[0]) throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    if (order.rows[0].status === "pending_review") return { status: "pending_review" };
    if (order.rows[0].status !== "pending_evidence") throw new ResearchApiError("ORDER_STATE_CONFLICT", "当前订单状态不可提交", 409);
    const evidence = await client.query(`SELECT 1 FROM commercial_payment_evidence WHERE membership_order_id=$1 LIMIT 1`, [orderId]);
    if (!evidence.rows[0]) throw new ResearchApiError("PAYMENT_EVIDENCE_REQUIRED", "请先记录外部付款凭证", 422);
    await client.query(`UPDATE commercial_membership_orders SET status='pending_review',submitted_by_user_id=$2,submitted_at=now(),updated_at=now() WHERE id=$1`, [orderId, actorUserId]);
    return { status: "pending_review" };
  });
}

export async function decideMembershipOrder(pool: Pool, input: {
  orderId: string; reviewerUserId: string; decision: "approve" | "reject";
  note: string; idempotencyKey: string; requestId: string;
}) {
  return inTransaction(pool, async client => {
    const prior = await client.query(`SELECT decision FROM commercial_membership_order_decisions WHERE idempotency_key=$1`, [input.idempotencyKey]);
    if (prior.rows[0]) return { status: prior.rows[0].decision === "approve" ? "approved" : "rejected", replayed: true };
    const order = await client.query<{
      id: string; user_id: string; status: string; submitted_by_user_id: string | null; plan_version_id: string;
      duration_days: number | null; ai_credit_grant: string; price_amount: string; price_currency: string;
    }>(`SELECT id,user_id,status,submitted_by_user_id,plan_version_id,duration_days,ai_credit_grant::text,price_amount::text,price_currency
        FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
    const row = order.rows[0];
    if (!row) throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    if (row.status !== "pending_review") throw new ResearchApiError("ORDER_STATE_CONFLICT", "订单已处理或尚未提交", 409);
    if (!row.submitted_by_user_id || row.submitted_by_user_id === input.reviewerUserId) throw new ResearchApiError("MAKER_CHECKER_REQUIRED", "申请人与审批人必须不同", 403);
    const matchingEvidence=await client.query(`SELECT 1 FROM commercial_payment_evidence
      WHERE membership_order_id=$1 AND currency=$2 AND amount=$3::numeric LIMIT 1`,[row.id,row.price_currency,row.price_amount]);
    if(!matchingEvidence.rows[0])throw new ResearchApiError("PAYMENT_EVIDENCE_MISMATCH","付款凭证金额或币种与订单快照不一致",422);
    await client.query(`INSERT INTO commercial_membership_order_decisions
      (id,order_id,reviewer_user_id,decision,note,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), row.id, input.reviewerUserId, input.decision, input.note.slice(0, 500), input.idempotencyKey]);
    if (input.decision === "reject") {
      await client.query(`UPDATE commercial_membership_orders SET status='rejected',reviewed_by_user_id=$2,reviewed_at=now(),rejection_reason=$3,updated_at=now() WHERE id=$1`, [row.id,input.reviewerUserId,input.note.slice(0,500)]);
      return { status: "rejected", replayed: false };
    }
    const membershipResult = await client.query<{ id: string; expires_at: string | null; status: string }>(`
      SELECT id,expires_at,status FROM memberships WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [row.user_id]);
    const membershipId = membershipResult.rows[0]?.id ?? randomUUID();
    const before = membershipResult.rows[0] ?? null;
    const now = new Date();
    const existingExpiry = before?.expires_at ? new Date(before.expires_at) : now;
    const base = existingExpiry > now ? existingExpiry : now;
    const expiresAt = row.duration_days === null ? null : new Date(base.getTime() + row.duration_days * 86_400_000).toISOString();
    if (before) {
      await client.query(`UPDATE memberships SET plan_code=$2,status='active',starts_at=COALESCE(starts_at,$3),expires_at=$4,updated_at=$3 WHERE id=$1`,
        [membershipId,row.plan_version_id,now.toISOString(),expiresAt]);
    } else {
      await client.query(`INSERT INTO memberships (id,customer_id,plan_code,status,starts_at,expires_at) VALUES ($1,$2,$3,'active',$4,$5)`,
        [membershipId,row.user_id,row.plan_version_id,now.toISOString(),expiresAt]);
    }
    const clearingId = await ensurePlatformLedgerAccount(client, "platform_deposit_clearing", row.price_currency);
    const feeId = await ensurePlatformLedgerAccount(client, "platform_fee", row.price_currency);
    const ledger = await postCommercialLedgerTransaction(client, {
      transactionType: "membership_purchase", sourceType: "commercial_membership_order", sourceId: row.id,
      currency: row.price_currency, idempotencyKey: `membership-ledger:${row.id}`, requestId: input.requestId,
      createdByUserId: input.reviewerUserId, metadata: { orderId: row.id, planVersionId: row.plan_version_id },
      postings: [{ accountId: clearingId, side: "debit", amount: row.price_amount }, { accountId: feeId, side: "credit", amount: row.price_amount }],
      audit:{action:"commercial.membership.approved",subjectType:"commercial_membership_order",subjectId:row.id,
        before:{status:"pending_review"},after:{status:"approved",membershipId}},
      outbox:{userId:row.user_id,category:"membership",templateKey:"membership_approved",payload:{orderId:row.id},dedupeKey:`membership-approved:${row.id}`},
    });
    await mutateAiCredits(client, { userId: row.user_id, type: "grant", availableDelta: BigInt(row.ai_credit_grant), reservedDelta: BigInt(0),
      sourceType: "commercial_membership_order", sourceId: row.id, idempotencyKey: `membership-credit:${row.id}`,
      requestId: input.requestId, actorUserId: input.reviewerUserId });
    await client.query(`INSERT INTO membership_entitlement_events
      (id,membership_id,order_id,user_id,event_type,before_json,after_json,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [randomUUID(),membershipId,row.id,row.user_id,before ? "renewed" : "activated",JSON.stringify(before ?? {}),
      JSON.stringify({ planVersionId: row.plan_version_id, expiresAt }),`membership-entitlement:${row.id}`]);
    await client.query(`UPDATE commercial_membership_orders SET status='approved',approved_membership_id=$2,ledger_transaction_id=$3,
      reviewed_by_user_id=$4,reviewed_at=now(),updated_at=now() WHERE id=$1`, [row.id,membershipId,ledger.id,input.reviewerUserId]);
    return { status: "approved", membershipId, ledgerTransactionId: ledger.id, replayed: false };
  });
}
