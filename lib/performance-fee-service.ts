import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  fingerprintPaymentReference,
  maskPaymentReference,
  PAYMENT_REFERENCE_FINGERPRINT_VERSION,
  previousCompleteUtcWeek,
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
  calculateWeeklyPerformanceFee,
  compareSignedDecimalStrings,
} from "../packages/domain/src/commercial-membership-domain.ts";
import {
  type OfficialThreeCardAggregateReader,
  resolveCommercialOfficialPaperScope,
} from "./commercial-portfolio-scope.ts";
import { ResearchApiError } from "./research-errors.ts";

type CommercialMutationAuthorization = (
  client: PoolClient,
  customerId: string,
) => Promise<void>;

async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function auditOutbox(
  client: PoolClient,
  input: {
    actorUserId: string;
    userId: string;
    action: string;
    statementId: string;
    before: unknown;
    after: unknown;
    templateKey: string;
    dedupeKey: string;
  },
) {
  await client.query(
    `INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json) VALUES($1,$2,$3,'performance_fee_statement',$4,$5,$6)`,
    [
      randomUUID(),
      input.actorUserId,
      input.action,
      input.statementId,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
    ],
  );
  await client.query(
    `INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key) VALUES($1,$2,'in_app','performance_fee',$3,$4,'queued',$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      randomUUID(),
      input.userId,
      input.templateKey,
      JSON.stringify({ statementId: input.statementId }),
      new Date().toISOString(),
      input.dedupeKey,
    ],
  );
}

export async function generatePerformanceStatement(
  pool: Pool,
  input: {
    userId: string;
    generatedByUserId: string;
    requestId: string;
    idempotencyKey: string;
    now?: Date;
    readOfficialAggregate?: OfficialThreeCardAggregateReader;
    authorize?: CommercialMutationAuthorization;
  },
) {
  const asOf = input.now ?? new Date();
  const period = previousCompleteUtcWeek(asOf);
  return transaction(pool, async (client) => {
    const customer = await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [
      input.userId,
    ]);
    if (!customer.rows[0])
      throw new ResearchApiError("CUSTOMER_NOT_FOUND", "客户不存在", 404);
    await input.authorize?.(client, input.userId);
    const claim = await claimCommercialIdempotency(client, {
      operation: "performance.statement.generate",
      key: input.idempotencyKey,
      actorUserId: input.generatedByUserId,
      subjectType: "user",
      subjectId: input.userId,
      resourceId: `${period.weekStart}/${period.weekEnd}`,
      stage: "generate",
      payload: { userId: input.userId, period },
      sourceType: "complete_utc_week",
      sourceId: period.weekStart,
      currency: "USDT",
    });
    if (claim.replayed) return claim.response as Record<string, unknown>;
    const last = await client.query<{
      id: string;
      week_start: Date;
      week_end: Date;
      status: string;
      revision: number;
    }>(
      `SELECT id,week_start,week_end,status,revision FROM performance_fee_statements WHERE user_id=$1 ORDER BY week_end DESC,revision DESC LIMIT 1 FOR UPDATE`,
      [input.userId],
    );
    let revision = 1,
      replacesStatementId: string | null = null;
    if (last.rows[0]) {
      const prior = last.rows[0],
        samePeriod =
          prior.week_start.toISOString() === period.weekStart &&
          prior.week_end.toISOString() === period.weekEnd;
      if (samePeriod) {
        if (prior.status !== "rejected")
          throw new ResearchApiError(
            "STATEMENT_PERIOD_EXISTS",
            "该结算周已有有效结算单",
            409,
            { statementId: prior.id },
          );
        revision = prior.revision + 1;
        replacesStatementId = prior.id;
      } else {
        if (prior.week_end.toISOString() !== period.weekStart)
          throw new ResearchApiError(
            "STATEMENT_SEQUENCE_GAP",
            "结算周必须紧接上一结算周",
            409,
            { previousStatementId: prior.id },
          );
        if (!["paid", "no_fee"].includes(prior.status))
          throw new ResearchApiError(
            "UNFINISHED_STATEMENT_BLOCKS_PERIOD",
            "前序结算单尚未完成付款或零费用关闭",
            409,
            { statementId: prior.id },
          );
      }
    }
    const entitlement = await client.query<{
      membership_id: string;
      plan_version_id: string;
      performance_fee_bps: number;
    }>(
      `SELECT e.membership_id,o.plan_version_id,o.performance_fee_bps FROM membership_entitlement_events e JOIN commercial_membership_orders o ON o.id=e.order_id WHERE e.user_id=$1 AND o.status='activated' AND e.valid_from<=$2 AND (e.valid_until IS NULL OR e.valid_until>=$3) ORDER BY e.valid_from DESC,e.created_at DESC LIMIT 1 FOR SHARE`,
      [input.userId, period.weekStart, period.weekEnd],
    );
    if (!entitlement.rows[0])
      throw new ResearchApiError(
        "WEEK_ENTITLEMENT_REQUIRED",
        "客户在该完整周没有覆盖全周的商业会员权益",
        422,
      );
    const scope = await resolveCommercialOfficialPaperScope(
      client,
      {
        membershipId: entitlement.rows[0].membership_id,
        customerId: input.userId,
        asOf,
      },
      { aggregate: input.readOfficialAggregate },
    );
    const scopeSnapshot = {
      source: "official_three_card_portfolio" as const,
      scopeKey: scope.scopeKey,
      scopeVersion: scope.scopeVersion,
      customerId: scope.customerId,
      membershipId: scope.membershipId,
      period: scope.period,
      weeklyGrossRealizedPnl: scope.realizedGrossPnlUsdt,
      simulatedFees: scope.feesUsdt,
      strategies: scope.strategies.map((strategy) => ({
        strategyCode: strategy.strategyCode,
        portfolioId: strategy.portfolioId,
        weeklyGrossRealizedPnl: strategy.realizedGrossPnlUsdt,
        weeklyNetRealizedPnl: strategy.realizedNetPnlUsdt,
        simulatedFees: strategy.feesUsdt,
      })),
    };
    await client.query(
      `INSERT INTO performance_fee_high_water_marks(user_id,cumulative_net_pnl,high_water_mark) VALUES($1,$2,$2) ON CONFLICT DO NOTHING`,
      [input.userId, scope.priorNetPnl],
    );
    const hwm = await client.query<{ high_water_mark: string }>(
      `SELECT high_water_mark::text FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE`,
      [input.userId],
    );
    const fee = calculateWeeklyPerformanceFee({
      weekNetPnl: scope.weekNetPnl,
      cumulativeNetPnl: scope.cumulativeNetPnl,
      committedHighWaterMark: hwm.rows[0].high_water_mark,
      feeBps: entitlement.rows[0].performance_fee_bps,
    });
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO performance_fee_statements(id,user_id,membership_id,plan_version_id,week_start,week_end,strategy_codes_json,week_net_pnl,cumulative_net_pnl,prior_high_water_mark,eligible_profit,loss_carry,fee_bps,fee_amount,currency,generated_by_user_id,request_id,revision,replaces_statement_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,'USDT',$15,$16,$17,$18) RETURNING *`,
      [
        id,
        input.userId,
        entitlement.rows[0].membership_id,
        entitlement.rows[0].plan_version_id,
        period.weekStart,
        period.weekEnd,
        JSON.stringify(scopeSnapshot),
        fee.weekNetPnl,
        fee.cumulativeNetPnl,
        fee.committedHighWaterMark,
        fee.eligibleProfit,
        fee.lossCarry,
        entitlement.rows[0].performance_fee_bps,
        fee.feeAmount,
        input.generatedByUserId,
        input.requestId,
        revision,
        replacesStatementId,
      ],
    );
    await auditOutbox(client, {
      actorUserId: input.generatedByUserId,
      userId: input.userId,
      action: "commercial.performance.generated",
      statementId: id,
      before: replacesStatementId ? { replacesStatementId } : {},
      after: {
        status: "pending_review",
        weekStart: period.weekStart,
        weekEnd: period.weekEnd,
        revision,
        scope: scopeSnapshot,
      },
      templateKey: "performance_statement_generated",
      dedupeKey: `performance-generated:${id}`,
    });
    await completeCommercialIdempotency(
      client,
      "performance.statement.generate",
      input.idempotencyKey,
      result.rows[0],
    );
    return result.rows[0];
  });
}

async function recomputeStatement(
  client: PoolClient,
  row: {
    user_id: string;
    membership_id: string;
    week_start: Date;
    week_end: Date;
    strategy_codes_json: {
      source?: string;
      scopeKey?: string;
      scopeVersion?: string;
      customerId?: string;
      membershipId?: string;
      period?: { start?: string; end?: string };
      weeklyGrossRealizedPnl?: string;
      simulatedFees?: string;
      strategies?: Array<{
        strategyCode?: string;
        portfolioId?: string;
        weeklyGrossRealizedPnl?: string;
        weeklyNetRealizedPnl?: string;
        simulatedFees?: string;
      }>;
    };
    week_net_pnl: string;
    cumulative_net_pnl: string;
    prior_high_water_mark: string;
    eligible_profit: string;
    loss_carry: string;
    fee_bps: number;
    fee_amount: string;
  },
  readOfficialAggregate?: OfficialThreeCardAggregateReader,
) {
  const scope = await resolveCommercialOfficialPaperScope(
    client,
    {
      membershipId: row.membership_id,
      customerId: row.user_id,
      asOf: row.week_end,
    },
    { aggregate: readOfficialAggregate },
  );
  const expectedSnapshot = {
    source: "official_three_card_portfolio",
    scopeKey: scope.scopeKey,
    scopeVersion: scope.scopeVersion,
    customerId: scope.customerId,
    membershipId: scope.membershipId,
    period: scope.period,
    weeklyGrossRealizedPnl: scope.realizedGrossPnlUsdt,
    simulatedFees: scope.feesUsdt,
    strategies: scope.strategies.map((strategy) => ({
      strategyCode: strategy.strategyCode,
      portfolioId: strategy.portfolioId,
      weeklyGrossRealizedPnl: strategy.realizedGrossPnlUsdt,
      weeklyNetRealizedPnl: strategy.realizedNetPnlUsdt,
      simulatedFees: strategy.feesUsdt,
    })),
  };
  const storedStrategies = row.strategy_codes_json.strategies;
  if (
    row.week_start.toISOString() !== scope.period.start ||
    row.week_end.toISOString() !== scope.period.end ||
    row.strategy_codes_json.source !== expectedSnapshot.source ||
    row.strategy_codes_json.scopeKey !== expectedSnapshot.scopeKey ||
    row.strategy_codes_json.scopeVersion !== expectedSnapshot.scopeVersion ||
    row.strategy_codes_json.customerId !== expectedSnapshot.customerId ||
    row.strategy_codes_json.membershipId !== expectedSnapshot.membershipId ||
    row.strategy_codes_json.period?.start !== expectedSnapshot.period.start ||
    row.strategy_codes_json.period?.end !== expectedSnapshot.period.end ||
    !Array.isArray(storedStrategies) ||
    storedStrategies.length !== expectedSnapshot.strategies.length ||
    expectedSnapshot.strategies.some((expected, index) => {
      const stored = storedStrategies[index];
      return (
        stored?.strategyCode !== expected.strategyCode ||
        stored.portfolioId !== expected.portfolioId
      );
    })
  )
    throw new ResearchApiError(
      "STATEMENT_SCOPE_INVALID",
      "结算单官方三卡范围快照无效",
      409,
    );
  if (
    row.strategy_codes_json.weeklyGrossRealizedPnl !==
      expectedSnapshot.weeklyGrossRealizedPnl ||
    row.strategy_codes_json.simulatedFees !== expectedSnapshot.simulatedFees ||
    expectedSnapshot.strategies.some((expected, index) => {
      const stored = storedStrategies[index];
      return (
        stored?.weeklyGrossRealizedPnl !== expected.weeklyGrossRealizedPnl ||
        stored.weeklyNetRealizedPnl !== expected.weeklyNetRealizedPnl ||
        stored.simulatedFees !== expected.simulatedFees
      );
    })
  ) {
    throw new ResearchApiError(
      "STATEMENT_STALE",
      "结算单数据已变化，请重新生成",
      409,
    );
  }
  const fee = calculateWeeklyPerformanceFee({
    weekNetPnl: scope.weekNetPnl,
    cumulativeNetPnl: scope.cumulativeNetPnl,
    committedHighWaterMark: row.prior_high_water_mark,
    feeBps: row.fee_bps,
  });
  const values = [
      fee.weekNetPnl,
      fee.cumulativeNetPnl,
      fee.committedHighWaterMark,
      fee.eligibleProfit,
      fee.lossCarry,
      fee.feeAmount,
    ],
    stored = [
      row.week_net_pnl,
      row.cumulative_net_pnl,
      row.prior_high_water_mark,
      row.eligible_profit,
      row.loss_carry,
      row.fee_amount,
    ];
  if (
    values.some(
      (value, index) => compareSignedDecimalStrings(value, stored[index]) !== 0,
    )
  )
    throw new ResearchApiError(
      "STATEMENT_STALE",
      "结算单数据已变化，请重新生成",
      409,
    );
}

export async function decidePerformanceAssessment(
  pool: Pool,
  input: {
    statementId: string;
    reviewerUserId: string;
    decision: "approve" | "reject";
    note: string;
    idempotencyKey: string;
    readOfficialAggregate?: OfficialThreeCardAggregateReader;
    authorize?: CommercialMutationAuthorization;
  },
) {
  return transaction(pool, async (client) => {
    const result = await client.query(
      `SELECT id,user_id,membership_id,status,generated_by_user_id,fee_amount::text,currency,week_start,week_end,strategy_codes_json,week_net_pnl::text,cumulative_net_pnl::text,prior_high_water_mark::text,eligible_profit::text,loss_carry::text,fee_bps FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,
      [input.statementId],
    );
    const row = result.rows[0];
    if (!row)
      throw new ResearchApiError(
        "STATEMENT_NOT_FOUND",
        "分成结算单不存在",
        404,
      );
    await input.authorize?.(client, row.user_id);
    const claim = await claimCommercialIdempotency(client, {
      operation: "performance.statement.assessment",
      key: input.idempotencyKey,
      actorUserId: input.reviewerUserId,
      subjectType: "performance_fee_statement",
      subjectId: input.statementId,
      resourceId: row.user_id,
      stage: "assessment",
      decision: input.decision,
      payload: { decision: input.decision, note: input.note },
      sourceType: "performance_fee_statement",
      sourceId: input.statementId,
      currency: "USDT",
    });
    if (claim.replayed) return claim.response;
    if (row.status !== "pending_review")
      throw new ResearchApiError(
        "STATEMENT_STATE_CONFLICT",
        "结算单已处理",
        409,
      );
    if (row.generated_by_user_id === input.reviewerUserId)
      throw new ResearchApiError(
        "MAKER_CHECKER_REQUIRED",
        "生成人与审批人必须不同",
        403,
      );
    const prior = await client.query<{ status: string; id: string }>(
      `SELECT id,status FROM performance_fee_statements WHERE user_id=$1 AND week_end=$2 ORDER BY revision DESC,created_at DESC LIMIT 1 FOR UPDATE`,
      [row.user_id, row.week_start],
    );
    if (prior.rows[0] && !["paid", "no_fee"].includes(prior.rows[0].status))
      throw new ResearchApiError(
        "UNFINISHED_STATEMENT_BLOCKS_PERIOD",
        "前序结算单未完成",
        409,
        { statementId: prior.rows[0].id },
      );
    const hwm = await client.query<{ high_water_mark: string }>(
      `SELECT high_water_mark::text FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE`,
      [row.user_id],
    );
    if (
      !hwm.rows[0] ||
      compareSignedDecimalStrings(
        hwm.rows[0].high_water_mark,
        row.prior_high_water_mark,
      ) !== 0
    )
      throw new ResearchApiError(
        "STATEMENT_STALE",
        "高水位已变化，请重新生成",
        409,
      );
    await recomputeStatement(client, row, input.readOfficialAggregate);
    await client.query(
      `INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,idempotency_key) VALUES($1,$2,'assessment',$3,$4,$5,$6)`,
      [
        randomUUID(),
        input.statementId,
        input.reviewerUserId,
        input.decision,
        input.note,
        input.idempotencyKey,
      ],
    );
    let response: { status: string; replayed: boolean };
    if (input.decision === "reject") {
      await client.query(
        `UPDATE performance_fee_statements SET status='rejected',updated_at=now() WHERE id=$1`,
        [input.statementId],
      );
      response = { status: "rejected", replayed: false };
    } else if (compareSignedDecimalStrings(row.fee_amount, "0") === 0) {
      await client.query(
        `UPDATE performance_fee_statements SET status='no_fee',updated_at=now() WHERE id=$1`,
        [input.statementId],
      );
      response = { status: "no_fee", replayed: false };
    } else {
      await client.query(
        `INSERT INTO performance_fee_receivables(id,statement_id,amount,currency) VALUES($1,$2,$3,$4)`,
        [randomUUID(), input.statementId, row.fee_amount, row.currency],
      );
      await client.query(
        `UPDATE performance_fee_statements SET status='payment_pending',updated_at=now() WHERE id=$1`,
        [input.statementId],
      );
      response = { status: "payment_pending", replayed: false };
    }
    await auditOutbox(client, {
      actorUserId: input.reviewerUserId,
      userId: row.user_id,
      action: `commercial.performance.assessment.${input.decision}`,
      statementId: input.statementId,
      before: { status: "pending_review" },
      after: { status: response.status },
      templateKey: "performance_assessment_recorded",
      dedupeKey: `performance-assessment:${input.statementId}`,
    });
    await completeCommercialIdempotency(
      client,
      "performance.statement.assessment",
      input.idempotencyKey,
      response,
    );
    return response;
  });
}

export async function recordPerformancePaymentEvidence(
  pool: Pool,
  input: {
    statementId: string;
    actorUserId: string;
    evidenceKind: string;
    providerLabel?: string;
    reference: string;
    amount: string;
    currency: string;
    occurredAt: string;
    note?: string;
    idempotencyKey: string;
    authorize?: CommercialMutationAuthorization;
  },
) {
  if (
    !["bank_transfer", "manual_invoice", "provider_reference"].includes(
      input.evidenceKind,
    ) ||
    input.currency !== "USDT" ||
    !/^\d+(?:\.\d{1,18})?$/.test(input.amount) ||
    Number(input.amount) <= 0 ||
    !input.reference.trim() ||
    input.reference.length > 256 ||
    (input.note?.length ?? 0) > 500 ||
    Number.isNaN(new Date(input.occurredAt).valueOf()) ||
    new Date(input.occurredAt).getTime() > Date.now() + 300_000
  )
    throw new ResearchApiError("VALIDATION_ERROR", "付款凭证字段无效", 422);
  return transaction(pool, async (client) => {
    const statement = await client.query<{
      status: string;
      user_id: string;
      generated_by_user_id: string;
    }>(
      `SELECT status,user_id,generated_by_user_id FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,
      [input.statementId],
    );
    const row = statement.rows[0];
    if (!row)
      throw new ResearchApiError(
        "STATEMENT_NOT_FOUND",
        "分成结算单不存在",
        404,
      );
    await input.authorize?.(client, row.user_id);
    const assessment = await client.query<{ reviewer_user_id: string }>(
      `SELECT reviewer_user_id FROM performance_fee_decisions
       WHERE statement_id=$1 AND stage='assessment' AND decision='approve'
       ORDER BY created_at DESC,id DESC FOR SHARE`,
      [input.statementId],
    );
    if (assessment.rowCount !== 1) {
      throw new ResearchApiError(
        "PAYMENT_STAGE_INTEGRITY_CONFLICT",
        "分成结算单缺少唯一的 assessment 复核记录",
        409,
      );
    }
    if (
      input.actorUserId === row.generated_by_user_id ||
      input.actorUserId === assessment.rows[0]?.reviewer_user_id
    ) {
      throw new ResearchApiError(
        "PAYMENT_STAGE_SEPARATION_REQUIRED",
        "付款复核必须由另一组人员执行",
        403,
      );
    }
    const unresolvedFingerprintVersion = await client.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM commercial_payment_evidence
         WHERE reference_fingerprint_version IS DISTINCT FROM $1
       ) AS present`,
      [PAYMENT_REFERENCE_FINGERPRINT_VERSION],
    );
    if (unresolvedFingerprintVersion.rows[0]?.present)
      throw new ResearchApiError(
        "COMMERCIAL_PAYMENT_FINGERPRINT_RECONCILIATION_REQUIRED",
        "付款参考号指纹版本需要先完成受控核对",
        503,
      );
    const fingerprint = fingerprintPaymentReference(input.reference);
    const normalizedProvider = input.providerLabel?.slice(0, 80) ?? null;
    const normalizedOccurredAt = new Date(input.occurredAt).toISOString();
    const normalizedNote = input.note ?? "";
    const claim = await claimCommercialIdempotency(client, {
      operation: "performance.payment.evidence",
      key: input.idempotencyKey,
      actorUserId: input.actorUserId,
      subjectType: "performance_fee_statement",
      subjectId: input.statementId,
      resourceId: row.user_id,
      stage: "payment_evidence",
      payload: {
        evidenceKind: input.evidenceKind,
        providerLabel: normalizedProvider,
        referenceFingerprint: fingerprint,
        referenceFingerprintVersion: PAYMENT_REFERENCE_FINGERPRINT_VERSION,
        amount: input.amount,
        currency: input.currency,
        occurredAt: normalizedOccurredAt,
        note: normalizedNote,
      },
      sourceType: "payment_evidence",
      sourceId: `${PAYMENT_REFERENCE_FINGERPRINT_VERSION}:${fingerprint}`,
      currency: "USDT",
    });
    if (claim.replayed) return claim.response;
    if (row.status !== "payment_pending")
      throw new ResearchApiError(
        "STATEMENT_STATE_CONFLICT",
        "结算单当前不等待付款确认",
        409,
      );
    const inserted = await client.query(
      `INSERT INTO commercial_payment_evidence(id,performance_statement_id,evidence_kind,provider_label,reference_masked,reference_fingerprint,reference_fingerprint_version,amount,currency,occurred_at,note,recorded_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id,membership_order_id,performance_statement_id,evidence_kind,provider_label,reference_masked,reference_fingerprint_version,amount::text,currency,occurred_at,note,recorded_by_user_id,status,reviewed_by_user_id,reviewed_at,created_at`,
      [
        randomUUID(),
        input.statementId,
        input.evidenceKind,
        normalizedProvider,
        maskPaymentReference(input.reference),
        fingerprint,
        PAYMENT_REFERENCE_FINGERPRINT_VERSION,
        input.amount,
        input.currency,
        input.occurredAt,
        normalizedNote,
        input.actorUserId,
      ],
    );
    let evidence = inserted.rows[0];
    const created = Boolean(evidence);
    if (!evidence) {
      const existing = await client.query(
        `SELECT id,membership_order_id,performance_statement_id,evidence_kind,provider_label,reference_masked,reference_fingerprint_version,amount::text,currency,occurred_at,note,recorded_by_user_id,status,reviewed_by_user_id,reviewed_at,created_at FROM commercial_payment_evidence WHERE reference_fingerprint_version=$1 AND reference_fingerprint=$2 FOR SHARE`,
        [PAYMENT_REFERENCE_FINGERPRINT_VERSION, fingerprint],
      );
      evidence = existing.rows[0];
      if (
        !evidence ||
        evidence.reference_fingerprint_version !==
          PAYMENT_REFERENCE_FINGERPRINT_VERSION ||
        evidence.performance_statement_id !== input.statementId ||
        evidence.membership_order_id !== null ||
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
      await auditOutbox(client, {
        actorUserId: input.actorUserId,
        userId: row.user_id,
        action: "commercial.performance.payment_evidence",
        statementId: input.statementId,
        before: { status: "payment_pending" },
        after: { paymentEvidenceId: evidence.id, status: evidence.status },
        templateKey: "performance_payment_evidence_recorded",
        dedupeKey: `performance-evidence:${evidence.id}`,
      });
    await completeCommercialIdempotency(
      client,
      "performance.payment.evidence",
      input.idempotencyKey,
      evidence,
    );
    return evidence;
  });
}

export async function decidePerformancePayment(
  pool: Pool,
  input: {
    statementId: string;
    reviewerUserId: string;
    decision: "approve" | "reject";
    note: string;
    paymentEvidenceId: string;
    idempotencyKey: string;
    requestId: string;
    authorize?: CommercialMutationAuthorization;
  },
) {
  return transaction(pool, async (client) => {
    const statement = await client.query<{
      status: string;
      user_id: string;
      generated_by_user_id: string;
      cumulative_net_pnl: string;
      fee_amount: string;
      currency: string;
    }>(
      `SELECT status,user_id,generated_by_user_id,cumulative_net_pnl::text,fee_amount::text,currency FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,
      [input.statementId],
    );
    const row = statement.rows[0];
    if (!row)
      throw new ResearchApiError(
        "STATEMENT_NOT_FOUND",
        "分成结算单不存在",
        404,
      );
    await input.authorize?.(client, row.user_id);
    const claim = await claimCommercialIdempotency(client, {
      operation: "performance.payment.decision",
      key: input.idempotencyKey,
      actorUserId: input.reviewerUserId,
      subjectType: "performance_fee_statement",
      subjectId: input.statementId,
      resourceId: row.user_id,
      stage: "payment",
      decision: input.decision,
      payload: {
        decision: input.decision,
        note: input.note,
        paymentEvidenceId: input.paymentEvidenceId,
      },
      sourceType: "performance_fee_statement",
      sourceId: input.statementId,
      currency: "USDT",
    });
    if (claim.replayed) return claim.response;
    if (row.status !== "payment_pending")
      throw new ResearchApiError(
        "STATEMENT_STATE_CONFLICT",
        "结算单当前不等待付款确认",
        409,
      );
    const assessment = await client.query<{ reviewer_user_id: string }>(
      `SELECT reviewer_user_id FROM performance_fee_decisions
       WHERE statement_id=$1 AND stage='assessment' AND decision='approve'
       ORDER BY created_at DESC,id DESC FOR SHARE`,
      [input.statementId],
    );
    if (assessment.rowCount !== 1) {
      throw new ResearchApiError(
        "PAYMENT_STAGE_INTEGRITY_CONFLICT",
        "分成结算单缺少唯一的 assessment 复核记录",
        409,
      );
    }
    const assessmentReviewer = assessment.rows[0]?.reviewer_user_id;
    if (
      input.reviewerUserId === row.generated_by_user_id ||
      input.reviewerUserId === assessmentReviewer
    ) {
      throw new ResearchApiError(
        "PAYMENT_STAGE_SEPARATION_REQUIRED",
        "付款复核必须由另一组人员执行",
        403,
      );
    }
    const evidence = await client.query<{
      id: string;
      recorded_by_user_id: string;
    }>(
      `SELECT e.id,e.recorded_by_user_id FROM commercial_payment_evidence e JOIN performance_fee_receivables r ON r.statement_id=e.performance_statement_id WHERE e.id=$1 AND e.performance_statement_id=$2 AND e.currency=r.currency AND e.amount=r.amount AND e.status='recorded' FOR UPDATE OF e`,
      [input.paymentEvidenceId, input.statementId],
    );
    const selected = evidence.rows[0];
    if (!selected)
      throw new ResearchApiError(
        "PAYMENT_EVIDENCE_REQUIRED",
        "缺少金额币种匹配的待审付款凭证",
        422,
      );
    if (
      selected.recorded_by_user_id === row.generated_by_user_id ||
      selected.recorded_by_user_id === assessmentReviewer
    ) {
      throw new ResearchApiError(
        "PAYMENT_STAGE_SEPARATION_REQUIRED",
        "付款复核必须由另一组人员执行",
        403,
      );
    }
    if (selected.recorded_by_user_id === input.reviewerUserId)
      throw new ResearchApiError(
        "MAKER_CHECKER_REQUIRED",
        "付款凭证记录人与审批人必须不同",
        403,
      );
    await client.query(
      `INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key) VALUES($1,$2,'payment',$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        input.statementId,
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
      const response = {
        status: "payment_pending",
        paymentEvidenceId: selected.id,
        replayed: false,
      };
      await auditOutbox(client, {
        actorUserId: input.reviewerUserId,
        userId: row.user_id,
        action: "commercial.performance.payment.reject",
        statementId: input.statementId,
        before: {
          status: "payment_pending",
          paymentEvidenceId: selected.id,
        },
        after: {
          status: "payment_pending",
          paymentEvidenceId: selected.id,
          evidenceStatus: "rejected",
        },
        templateKey: "performance_payment_rejected",
        dedupeKey: `performance-payment-rejected:${input.statementId}:${input.idempotencyKey}`,
      });
      await completeCommercialIdempotency(
        client,
        "performance.payment.decision",
        input.idempotencyKey,
        response,
      );
      return response;
    }
    await client.query(
      `SELECT 1 FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE`,
      [row.user_id],
    );
    const clearing = await ensurePlatformLedgerAccount(
        client,
        "platform_deposit_clearing",
        "USDT",
      ),
      fee = await ensurePlatformLedgerAccount(client, "platform_fee", "USDT");
    const ledger = await postCommercialLedgerTransaction(client, {
      transactionType: "performance_fee_payment",
      sourceType: "performance_fee_statement",
      sourceId: input.statementId,
      currency: "USDT",
      idempotencyKey: `performance-paid:${input.statementId}`,
      requestId: input.requestId,
      createdByUserId: input.reviewerUserId,
      postings: [
        { accountId: clearing, side: "debit", amount: row.fee_amount },
        { accountId: fee, side: "credit", amount: row.fee_amount },
      ],
      metadata: {
        statementId: input.statementId,
        evidenceId: selected.id,
      },
      audit: {
        action: "commercial.performance.paid",
        subjectType: "performance_fee_statement",
        subjectId: input.statementId,
        before: { status: "payment_pending" },
        after: { status: "paid", paymentEvidenceId: selected.id },
      },
      outbox: {
        userId: row.user_id,
        category: "performance_fee",
        templateKey: "performance_fee_paid",
        payload: { statementId: input.statementId },
        dedupeKey: `performance-paid:${input.statementId}`,
      },
    });
    await client.query(
      `UPDATE performance_fee_high_water_marks SET cumulative_net_pnl=$2,high_water_mark=GREATEST(high_water_mark,$2::numeric),last_paid_statement_id=$3,version=version+1,updated_at=now() WHERE user_id=$1`,
      [row.user_id, row.cumulative_net_pnl, input.statementId],
    );
    await client.query(
      `UPDATE commercial_payment_evidence SET status='accepted',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1`,
      [selected.id, input.reviewerUserId],
    );
    await client.query(
      `UPDATE performance_fee_receivables SET status='paid',payment_evidence_id=$2,paid_at=now() WHERE statement_id=$1`,
      [input.statementId, selected.id],
    );
    await client.query(
      `UPDATE performance_fee_statements SET status='paid',ledger_transaction_id=$2,updated_at=now() WHERE id=$1`,
      [input.statementId, ledger.id],
    );
    const response = {
      status: "paid",
      ledgerTransactionId: ledger.id,
      paymentEvidenceId: selected.id,
      replayed: false,
    };
    await completeCommercialIdempotency(
      client,
      "performance.payment.decision",
      input.idempotencyKey,
      response,
    );
    return response;
  });
}
