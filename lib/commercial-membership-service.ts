import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { mutateAiCredits } from "./ai-credit-service.ts";
import {
  fingerprintPaymentReference,
  maskPaymentReference,
} from "./commercial-api-support.ts";
import {
  claimCommercialIdempotency,
  completeCommercialIdempotency,
} from "./commercial-idempotency.ts";
import {
  ensurePlatformLedgerAccount,
  postCommercialLedgerTransaction,
} from "./commercial-ledger-service.ts";
import {
  compareSignedDecimalStrings,
  requiredLegalDocumentTypes,
} from "./commercial-membership-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

async function inTransaction<T>(
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

async function membershipAuditOutbox(
  client: PoolClient,
  input: {
    actorUserId: string;
    userId: string;
    orderId: string;
    action: string;
    before: unknown;
    after: unknown;
    templateKey: string;
    dedupeKey: string;
  },
) {
  await client.query(
    `INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json) VALUES($1,$2,$3,'commercial_membership_order',$4,$5,$6)`,
    [
      randomUUID(),
      input.actorUserId,
      input.action,
      input.orderId,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
    ],
  );
  await client.query(
    `INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key) VALUES($1,$2,'in_app','membership',$3,$4,'queued',$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      randomUUID(),
      input.userId,
      input.templateKey,
      JSON.stringify({ orderId: input.orderId }),
      new Date().toISOString(),
      input.dedupeKey,
    ],
  );
}

async function currentLegalDocuments(client: PoolClient) {
  const result = await client.query<{
    id: string;
    document_type: string;
    version: number;
    content_sha256: string;
  }>(
    `SELECT id,document_type,version,content_sha256 FROM commercial_legal_document_versions WHERE status='active' AND effective_at<=now() AND approved_at IS NOT NULL ORDER BY document_type FOR SHARE`,
  );
  const byType = new Map(result.rows.map((row) => [row.document_type, row]));
  if (
    !requiredLegalDocumentTypes.every((type) => byType.has(type)) ||
    result.rows.length !== requiredLegalDocumentTypes.length
  )
    throw new ResearchApiError(
      "LEGAL_CONFIGURATION_INCOMPLETE",
      "当前法务文件尚未完成七项审批配置",
      503,
      { requiredDocumentTypes: requiredLegalDocumentTypes },
    );
  return result.rows;
}

export async function getCurrentCommercialLegalDocuments(pool: Pool) {
  const client = await pool.connect();
  try {
    return await currentLegalDocuments(client);
  } finally {
    client.release();
  }
}

export async function createMembershipOrder(
  pool: Pool,
  input: {
    userId: string;
    planVersionId: string;
    acceptedDocumentVersionIds: string[];
    idempotencyKey: string;
    requestId: string;
    trustedIp?: string | null;
    userAgent?: string;
  },
) {
  return inTransaction(pool, async (client) => {
    const legalIds = [...new Set(input.acceptedDocumentVersionIds)].sort();
    const claim = await claimCommercialIdempotency(client, {
      operation: "membership.order.create",
      key: input.idempotencyKey,
      actorUserId: input.userId,
      subjectType: "user",
      subjectId: input.userId,
      resourceId: input.planVersionId,
      stage: "create",
      payload: {
        planVersionId: input.planVersionId,
        acceptedDocumentVersionIds: legalIds,
      },
      sourceType: "commercial_plan_version",
      sourceId: input.planVersionId,
      currency: "USD",
    });
    if (claim.replayed) return claim.response as Record<string, unknown>;
    const plan = await client.query<{
      id: string;
      plan_code: string;
      version: number;
      price_amount: string;
      price_currency: string;
      duration_days: number | null;
      ai_credit_grant: string;
      performance_fee_bps: number;
    }>(
      `SELECT id,plan_code,version,price_amount::text,price_currency,duration_days,ai_credit_grant::text,performance_fee_bps FROM commercial_plan_versions WHERE id=$1 AND status='active' AND effective_at<=now()`,
      [input.planVersionId],
    );
    const planRow = plan.rows[0];
    if (!planRow)
      throw new ResearchApiError(
        "PLAN_NOT_AVAILABLE",
        "会员计划当前不可购买",
        422,
      );
    const currentLegal = await currentLegalDocuments(client);
    const currentIds = currentLegal.map((row) => row.id).sort();
    if (
      legalIds.length !== currentIds.length ||
      legalIds.some((id, index) => id !== currentIds[index])
    )
      throw new ResearchApiError(
        "LEGAL_ACCEPTANCE_REQUIRED",
        "订单只能接受当前七项法务文件版本",
        422,
        { requiredDocumentVersionIds: currentIds },
      );
    for (const document of currentLegal)
      await client.query(
        `INSERT INTO commercial_legal_acceptances(id,user_id,document_version_id,ip_address,user_agent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,document_version_id) DO NOTHING`,
        [
          randomUUID(),
          input.userId,
          document.id,
          input.trustedIp ?? null,
          input.userAgent?.slice(0, 512) ?? null,
        ],
      );
    const orderId = randomUUID(),
      orderNo = `MEM-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 8).toUpperCase()}`;
    const legalSnapshot = currentLegal.map((row) => ({
      id: row.id,
      type: row.document_type,
      version: row.version,
      contentSha256: row.content_sha256,
    }));
    const result = await client.query(
      `INSERT INTO commercial_membership_orders(id,order_no,user_id,plan_version_id,price_amount,price_currency,duration_days,ai_credit_grant,performance_fee_bps,legal_snapshot_json,idempotency_key,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
      [
        orderId,
        orderNo,
        input.userId,
        planRow.id,
        planRow.price_amount,
        planRow.price_currency,
        planRow.duration_days,
        planRow.ai_credit_grant,
        planRow.performance_fee_bps,
        JSON.stringify(legalSnapshot),
        input.idempotencyKey,
        input.requestId,
      ],
    );
    const response = {
      ...result.rows[0],
      plan_code: planRow.plan_code,
      version: planRow.version,
    };
    await membershipAuditOutbox(client, {
      actorUserId: input.userId,
      userId: input.userId,
      orderId,
      action: "commercial.membership.order_created",
      before: {},
      after: { status: "pending_evidence", planVersionId: planRow.id },
      templateKey: "membership_order_created",
      dedupeKey: `membership-order-created:${orderId}`,
    });
    await completeCommercialIdempotency(
      client,
      "membership.order.create",
      input.idempotencyKey,
      response,
    );
    return response;
  });
}

function assertEvidence(
  input: {
    evidenceKind: string;
    reference: string;
    amount: string;
    currency: string;
    occurredAt: string;
    note?: string;
  },
  currency: "USD" | "USDT",
) {
  if (
    !["bank_transfer", "manual_invoice", "provider_reference"].includes(
      input.evidenceKind,
    )
  )
    throw new ResearchApiError("VALIDATION_ERROR", "付款凭证类型无效", 422);
  if (!/^\d+(?:\.\d{1,18})?$/.test(input.amount) || Number(input.amount) <= 0)
    throw new ResearchApiError("VALIDATION_ERROR", "付款金额无效", 422);
  if (input.currency !== currency)
    throw new ResearchApiError(
      "VALIDATION_ERROR",
      `付款币种必须为 ${currency}`,
      422,
    );
  const occurred = new Date(input.occurredAt);
  if (
    Number.isNaN(occurred.valueOf()) ||
    occurred.getTime() > Date.now() + 300_000
  )
    throw new ResearchApiError("VALIDATION_ERROR", "付款时间无效", 422);
  if (
    !input.reference.trim() ||
    input.reference.length > 256 ||
    (input.note?.length ?? 0) > 500
  )
    throw new ResearchApiError("VALIDATION_ERROR", "付款凭证字段无效", 422);
}

export async function recordMembershipPaymentEvidence(
  pool: Pool,
  input: {
    orderId: string;
    actorUserId: string;
    evidenceKind: string;
    providerLabel?: string;
    reference: string;
    amount: string;
    currency: string;
    occurredAt: string;
    note?: string;
    idempotencyKey: string;
  },
) {
  assertEvidence(input, "USD");
  return inTransaction(pool, async (client) => {
    const order = await client.query<{ status: string; user_id: string }>(
      `SELECT status,user_id FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`,
      [input.orderId],
    );
    const row = order.rows[0];
    if (!row)
      throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    const fingerprint = fingerprintPaymentReference(input.reference);
    const claim = await claimCommercialIdempotency(client, {
      operation: "membership.order.evidence",
      key: input.idempotencyKey,
      actorUserId: input.actorUserId,
      subjectType: "commercial_membership_order",
      subjectId: input.orderId,
      resourceId: row.user_id,
      stage: "evidence",
      payload: {
        evidenceKind: input.evidenceKind,
        providerLabel: input.providerLabel ?? null,
        referenceFingerprint: fingerprint,
        amount: input.amount,
        currency: input.currency,
        occurredAt: new Date(input.occurredAt).toISOString(),
        note: input.note ?? "",
      },
      sourceType: "payment_evidence",
      sourceId: fingerprint,
      currency: input.currency,
    });
    if (claim.replayed) return claim.response;
    if (row.status !== "pending_evidence")
      throw new ResearchApiError(
        "ORDER_STATE_CONFLICT",
        "当前订单状态不可记录凭证",
        409,
      );
    const normalizedProvider = input.providerLabel?.slice(0, 80) ?? null,
      normalizedOccurredAt = new Date(input.occurredAt).toISOString(),
      normalizedNote = input.note ?? "";
    const result = await client.query(
      `INSERT INTO commercial_payment_evidence(id,membership_order_id,evidence_kind,provider_label,reference_masked,reference_fingerprint,amount,currency,occurred_at,note,recorded_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id,membership_order_id,performance_statement_id,evidence_kind,provider_label,reference_masked,amount::text,currency,occurred_at,note,recorded_by_user_id,status,reviewed_by_user_id,reviewed_at,created_at`,
      [
        randomUUID(),
        input.orderId,
        input.evidenceKind,
        normalizedProvider,
        maskPaymentReference(input.reference),
        fingerprint,
        input.amount,
        input.currency,
        input.occurredAt,
        normalizedNote,
        input.actorUserId,
      ],
    );
    let evidence = result.rows[0];
    const created = Boolean(evidence);
    if (!evidence) {
      const existing = await client.query(
        `SELECT id,membership_order_id,performance_statement_id,evidence_kind,provider_label,reference_masked,amount::text,currency,occurred_at,note,recorded_by_user_id,status,reviewed_by_user_id,reviewed_at,created_at FROM commercial_payment_evidence WHERE reference_fingerprint=$1 FOR SHARE`,
        [fingerprint],
      );
      evidence = existing.rows[0];
      if (
        !evidence ||
        evidence.membership_order_id !== input.orderId ||
        evidence.performance_statement_id !== null ||
        evidence.evidence_kind !== input.evidenceKind ||
        evidence.provider_label !== normalizedProvider ||
        compareSignedDecimalStrings(evidence.amount, input.amount) !== 0 ||
        evidence.currency !== input.currency ||
        new Date(evidence.occurred_at).toISOString() !== normalizedOccurredAt ||
        evidence.note !== normalizedNote ||
        evidence.recorded_by_user_id !== input.actorUserId
      )
        throw new ResearchApiError(
          "PAYMENT_REFERENCE_COLLISION",
          "该付款参考号已绑定不同凭证内容",
          409,
        );
    }
    if (created)
      await membershipAuditOutbox(client, {
        actorUserId: input.actorUserId,
        userId: row.user_id,
        orderId: input.orderId,
        action: "commercial.membership.evidence_recorded",
        before: { status: row.status },
        after: { paymentEvidenceId: evidence.id },
        templateKey: "membership_evidence_recorded",
        dedupeKey: `membership-evidence-recorded:${evidence.id}`,
      });
    await completeCommercialIdempotency(
      client,
      "membership.order.evidence",
      input.idempotencyKey,
      evidence,
    );
    return evidence;
  });
}

export async function submitMembershipOrder(
  pool: Pool,
  input: { orderId: string; actorUserId: string; idempotencyKey: string },
) {
  return inTransaction(pool, async (client) => {
    const order = await client.query<{ status: string; user_id: string }>(
      `SELECT status,user_id FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`,
      [input.orderId],
    );
    const row = order.rows[0];
    if (!row)
      throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    const claim = await claimCommercialIdempotency(client, {
      operation: "membership.order.submit",
      key: input.idempotencyKey,
      actorUserId: input.actorUserId,
      subjectType: "commercial_membership_order",
      subjectId: input.orderId,
      resourceId: row.user_id,
      stage: "submit",
      payload: { orderId: input.orderId },
    });
    if (claim.replayed) return claim.response;
    if (row.status !== "pending_evidence")
      throw new ResearchApiError(
        "ORDER_STATE_CONFLICT",
        "当前订单状态不可提交",
        409,
      );
    if (
      !(
        await client.query(
          `SELECT 1 FROM commercial_payment_evidence WHERE membership_order_id=$1 LIMIT 1`,
          [input.orderId],
        )
      ).rows[0]
    )
      throw new ResearchApiError(
        "PAYMENT_EVIDENCE_REQUIRED",
        "请先记录外部付款凭证",
        422,
      );
    await client.query(
      `UPDATE commercial_membership_orders SET status='pending_review',submitted_by_user_id=$2,submitted_at=now(),updated_at=now() WHERE id=$1`,
      [input.orderId, input.actorUserId],
    );
    const response = { status: "pending_review" };
    await membershipAuditOutbox(client, {
      actorUserId: input.actorUserId,
      userId: row.user_id,
      orderId: input.orderId,
      action: "commercial.membership.submitted",
      before: { status: "pending_evidence" },
      after: { status: "pending_review" },
      templateKey: "membership_submitted",
      dedupeKey: `membership-submitted:${input.orderId}`,
    });
    await completeCommercialIdempotency(
      client,
      "membership.order.submit",
      input.idempotencyKey,
      response,
    );
    return response;
  });
}

export async function decideMembershipOrder(
  pool: Pool,
  input: {
    orderId: string;
    reviewerUserId: string;
    decision: "approve" | "reject";
    note: string;
    paymentEvidenceId: string;
    idempotencyKey: string;
    requestId: string;
  },
) {
  return inTransaction(pool, async (client) => {
    const order = await client.query<{
      id: string;
      user_id: string;
      status: string;
      submitted_by_user_id: string | null;
      plan_version_id: string;
      duration_days: number | null;
      ai_credit_grant: string;
      price_amount: string;
      price_currency: string;
    }>(
      `SELECT id,user_id,status,submitted_by_user_id,plan_version_id,duration_days,ai_credit_grant::text,price_amount::text,price_currency FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`,
      [input.orderId],
    );
    const row = order.rows[0];
    if (!row)
      throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    const claim = await claimCommercialIdempotency(client, {
      operation: "membership.order.decision",
      key: input.idempotencyKey,
      actorUserId: input.reviewerUserId,
      subjectType: "commercial_membership_order",
      subjectId: row.id,
      resourceId: row.user_id,
      stage: "decision",
      decision: input.decision,
      payload: {
        decision: input.decision,
        note: input.note,
        paymentEvidenceId: input.paymentEvidenceId,
      },
      sourceType: "commercial_membership_order",
      sourceId: row.id,
      currency: row.price_currency,
    });
    if (claim.replayed) return claim.response as Record<string, unknown>;
    if (row.status !== "pending_review")
      throw new ResearchApiError(
        "ORDER_STATE_CONFLICT",
        "订单已处理或尚未提交",
        409,
      );
    if (
      !row.submitted_by_user_id ||
      row.submitted_by_user_id === input.reviewerUserId
    )
      throw new ResearchApiError(
        "MAKER_CHECKER_REQUIRED",
        "提交人与审批人必须不同",
        403,
      );
    const evidence = await client.query<{
      id: string;
      recorded_by_user_id: string;
    }>(
      `SELECT id,recorded_by_user_id FROM commercial_payment_evidence WHERE id=$1 AND membership_order_id=$2 AND currency=$3 AND amount=$4::numeric AND status='recorded' FOR UPDATE`,
      [input.paymentEvidenceId, row.id, row.price_currency, row.price_amount],
    );
    const selected = evidence.rows[0];
    if (!selected)
      throw new ResearchApiError(
        "PAYMENT_EVIDENCE_MISMATCH",
        "缺少金额币种匹配的待审付款凭证",
        422,
      );
    if (selected.recorded_by_user_id === input.reviewerUserId)
      throw new ResearchApiError(
        "MAKER_CHECKER_REQUIRED",
        "付款凭证记录人与审批人必须不同",
        403,
      );
    await client.query(
      `INSERT INTO commercial_membership_order_decisions(id,order_id,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        row.id,
        input.reviewerUserId,
        input.decision,
        input.note,
        selected.id,
        input.idempotencyKey,
      ],
    );
    if (input.decision === "reject") {
      await client.query(
        `UPDATE commercial_payment_evidence SET status='rejected',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1 AND status='recorded'`,
        [selected.id, input.reviewerUserId],
      );
      await client.query(
        `UPDATE commercial_membership_orders SET status='rejected',reviewed_by_user_id=$2,reviewed_at=now(),rejection_reason=$3,updated_at=now() WHERE id=$1`,
        [row.id, input.reviewerUserId, input.note],
      );
      await client.query(
        `INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json) VALUES($1,$2,'commercial.membership.rejected','commercial_membership_order',$3,$4,$5)`,
        [
          randomUUID(),
          input.reviewerUserId,
          row.id,
          JSON.stringify({ status: "pending_review" }),
          JSON.stringify({
            status: "rejected",
            paymentEvidenceId: selected.id,
          }),
        ],
      );
      await client.query(
        `INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key) VALUES($1,$2,'in_app','membership','membership_rejected',$3,'queued',$4,$5) ON CONFLICT(dedupe_key) DO NOTHING`,
        [
          randomUUID(),
          row.user_id,
          JSON.stringify({ orderId: row.id }),
          new Date().toISOString(),
          `membership-rejected:${row.id}`,
        ],
      );
      const response = {
        status: "rejected",
        paymentEvidenceId: selected.id,
        replayed: false,
      };
      await completeCommercialIdempotency(
        client,
        "membership.order.decision",
        input.idempotencyKey,
        response,
      );
      return response;
    }
    await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [
      row.user_id,
    ]);
    const memberships = await client.query<{
      id: string;
      expires_at: string | null;
      status: string;
      plan_code: string;
    }>(
      `SELECT id,expires_at,status,plan_code FROM memberships WHERE customer_id=$1 AND status IN ('active','grace','read_only') ORDER BY created_at DESC FOR UPDATE`,
      [row.user_id],
    );
    if (memberships.rows.length > 1)
      throw new ResearchApiError(
        "MEMBERSHIP_INTEGRITY_CONFLICT",
        "客户存在多个当前会员权益",
        409,
      );
    const before = memberships.rows[0] ?? null;
    if (
      before?.plan_code === "membership_lifetime_v1" &&
      row.duration_days !== null
    )
      throw new ResearchApiError(
        "LIFETIME_DOWNGRADE_FORBIDDEN",
        "终身会员不得被有限期计划降级",
        409,
      );
    const membershipId = before?.id ?? randomUUID(),
      now = new Date(),
      base =
        before?.expires_at && new Date(before.expires_at) > now
          ? new Date(before.expires_at)
          : now;
    const expiresAt =
      row.duration_days === null
        ? null
        : new Date(
            base.getTime() + row.duration_days * 86_400_000,
          ).toISOString();
    if (before)
      await client.query(
        `UPDATE memberships SET plan_code=$2,status='active',starts_at=COALESCE(starts_at,$3),expires_at=$4,updated_at=$3 WHERE id=$1`,
        [membershipId, row.plan_version_id, now.toISOString(), expiresAt],
      );
    else
      await client.query(
        `INSERT INTO memberships(id,customer_id,plan_code,status,starts_at,expires_at) VALUES($1,$2,$3,'active',$4,$5)`,
        [
          membershipId,
          row.user_id,
          row.plan_version_id,
          now.toISOString(),
          expiresAt,
        ],
      );
    const clearingId = await ensurePlatformLedgerAccount(
        client,
        "platform_deposit_clearing",
        row.price_currency,
      ),
      feeId = await ensurePlatformLedgerAccount(
        client,
        "platform_fee",
        row.price_currency,
      );
    const ledger = await postCommercialLedgerTransaction(client, {
      transactionType: "membership_purchase",
      sourceType: "commercial_membership_order",
      sourceId: row.id,
      currency: row.price_currency,
      idempotencyKey: `membership-ledger:${row.id}`,
      requestId: input.requestId,
      createdByUserId: input.reviewerUserId,
      metadata: {
        orderId: row.id,
        planVersionId: row.plan_version_id,
        evidenceId: selected.id,
      },
      postings: [
        { accountId: clearingId, side: "debit", amount: row.price_amount },
        { accountId: feeId, side: "credit", amount: row.price_amount },
      ],
      audit: {
        action: "commercial.membership.activated",
        subjectType: "commercial_membership_order",
        subjectId: row.id,
        before: { status: "pending_review" },
        after: { status: "activated", membershipId },
      },
      outbox: {
        userId: row.user_id,
        category: "membership",
        templateKey: "membership_activated",
        payload: { orderId: row.id },
        dedupeKey: `membership-activated:${row.id}`,
      },
    });
    await mutateAiCredits(client, {
      userId: row.user_id,
      type: "grant",
      availableDelta: BigInt(row.ai_credit_grant),
      reservedDelta: BigInt(0),
      sourceType: "commercial_membership_order",
      sourceId: row.id,
      idempotencyKey: `membership-credit:${row.id}`,
      requestId: input.requestId,
      actorUserId: input.reviewerUserId,
    });
    await client.query(
      `INSERT INTO membership_entitlement_events(id,membership_id,order_id,user_id,event_type,before_json,after_json,valid_from,valid_until,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [
        randomUUID(),
        membershipId,
        row.id,
        row.user_id,
        before ? "renewed" : "activated",
        JSON.stringify(before ?? {}),
        JSON.stringify({ planVersionId: row.plan_version_id, expiresAt }),
        now,
        expiresAt,
        `membership-entitlement:${row.id}`,
      ],
    );
    await client.query(
      `UPDATE commercial_payment_evidence SET status='accepted',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1 AND status='recorded'`,
      [selected.id, input.reviewerUserId],
    );
    await client.query(
      `UPDATE commercial_membership_orders SET status='activated',approved_membership_id=$2,ledger_transaction_id=$3,reviewed_by_user_id=$4,reviewed_at=now(),activated_at=now(),updated_at=now() WHERE id=$1`,
      [row.id, membershipId, ledger.id, input.reviewerUserId],
    );
    const response = {
      status: "activated",
      membershipId,
      ledgerTransactionId: ledger.id,
      paymentEvidenceId: selected.id,
      replayed: false,
    };
    await completeCommercialIdempotency(
      client,
      "membership.order.decision",
      input.idempotencyKey,
      response,
    );
    return response;
  });
}
