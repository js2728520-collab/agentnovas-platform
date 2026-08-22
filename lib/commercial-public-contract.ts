import { PAYMENT_REFERENCE_FINGERPRINT_VERSION } from "./commercial-api-support.ts";
import { compareSignedDecimalStrings } from "./commercial-membership-domain.ts";
import { ResearchApiError } from "./research-errors.ts";

const membershipStatuses = {
  pending_evidence: "AWAITING_EVIDENCE",
  pending_review: "SUBMITTED",
  activated: "ACTIVATED",
  rejected: "REJECTED",
  cancelled: "CANCELLED",
} as const;
const performanceStatuses = {
  pending_review: "SUBMITTED",
  approved: "APPROVED",
  payment_pending: "INVOICED",
  paid: "PAID",
  no_fee: "CLOSED_NO_FEE",
  rejected: "REJECTED",
} as const;
const evidenceStatuses = {
  recorded: "RECORDED",
  rejected: "REJECTED",
  accepted: "ACCEPTED",
} as const;
const planNames = {
  monthly_v1: "月卡",
  quarterly_v1: "季卡",
  annual_v1: "年卡",
  lifetime_v1: "终身会员",
} as const;

export function publicMembershipOrderStatus(status: string) {
  const value = membershipStatuses[status as keyof typeof membershipStatuses];
  if (!value) throw new Error("UNKNOWN_MEMBERSHIP_ORDER_STATUS");
  return value;
}
export function publicPerformanceStatementStatus(status: string) {
  const value = performanceStatuses[status as keyof typeof performanceStatuses];
  if (!value) throw new Error("UNKNOWN_PERFORMANCE_STATEMENT_STATUS");
  return value;
}
export function databaseMembershipOrderStatus(status: string) {
  const entry = Object.entries(membershipStatuses).find(
    ([, value]) => value === status,
  );
  if (!entry)
    throw new ResearchApiError(
      "UNKNOWN_MEMBERSHIP_ORDER_STATUS",
      "status 无效",
      422,
      { fields: ["status"] },
    );
  return entry[0];
}
export function databasePerformanceStatementStatus(status: string) {
  const entry = Object.entries(performanceStatuses).find(
    ([, value]) => value === status,
  );
  if (!entry)
    throw new ResearchApiError(
      "UNKNOWN_PERFORMANCE_STATEMENT_STATUS",
      "status 无效",
      422,
      { fields: ["status"] },
    );
  return entry[0];
}

function usd(value: unknown) {
  const [whole, fraction = ""] = String(value).split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}
function rate(value: unknown) {
  return (Number(value) / 10_000).toFixed(2);
}
function timestamp(value: unknown) {
  return value ? new Date(value as string | Date).toISOString() : null;
}
function legalDocuments(value: unknown) {
  if (!Array.isArray(value)) throw new Error("INVALID_LEGAL_SNAPSHOT");
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "");
    const type = String(row.type ?? "");
    const version = String(row.version ?? "");
    const contentSha256 = String(row.contentSha256 ?? "").toLowerCase();
    if (!id || !type || !version || !/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new Error("INVALID_LEGAL_SNAPSHOT");
    }
    return { id, type, version, contentSha256 };
  });
}

export function commercialPlanDto(row: Record<string, unknown>) {
  const code = String(row.plan_code) as keyof typeof planNames;
  if (!planNames[code]) throw new Error("UNKNOWN_COMMERCIAL_PLAN");
  return {
    code,
    name: planNames[code],
    priceUsd: usd(row.price_amount),
    priceCurrency: "USD" as const,
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    aiCredits: Number(row.ai_credit_grant),
    performanceFeeRate: rate(row.performance_fee_bps),
    isLifetime: code === "lifetime_v1",
    version: Number(row.version),
    isActive: row.status === undefined || row.status === "active",
  };
}
export function membershipOrderDto(row: Record<string, unknown>) {
  const plan = commercialPlanDto(row);
  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    customerId: String(row.user_id),
    status: publicMembershipOrderStatus(String(row.status)),
    plan: {
      code: plan.code,
      name: plan.name,
      priceUsd: plan.priceUsd,
      priceCurrency: plan.priceCurrency,
      durationDays: plan.durationDays,
      aiCredits: plan.aiCredits,
      performanceFeeRate: plan.performanceFeeRate,
      isLifetime: plan.isLifetime,
      version: plan.version,
    },
    legalDocuments: legalDocuments(row.legal_snapshot_json),
    paymentInstructionsStatus: "UNAVAILABLE" as const,
    submittedAt: timestamp(row.submitted_at),
    activatedAt: timestamp(row.activated_at),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}
export function performanceStatementDto(row: Record<string, unknown>) {
  const cumulativeNetPnl = String(row.cumulative_net_pnl);
  const priorHighWaterMark = String(row.prior_high_water_mark);
  const prospectiveHighWaterMark = compareSignedDecimalStrings(cumulativeNetPnl, priorHighWaterMark) > 0
    ? cumulativeNetPnl
    : priorHighWaterMark;
  const snapshot =
    row.strategy_codes_json &&
    typeof row.strategy_codes_json === "object" &&
    !Array.isArray(row.strategy_codes_json)
      ? (row.strategy_codes_json as Record<string, unknown>)
      : {};
  const strategyBreakdown = Array.isArray(snapshot.strategies)
    ? snapshot.strategies.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const strategy = value as Record<string, unknown>;
        const strategyCode = String(strategy.strategyCode ?? "");
        if (![
          "ai_conservative",
          "ai_balanced",
          "ai_aggressive",
        ].includes(strategyCode) ||
        typeof strategy.weeklyGrossRealizedPnl !== "string" ||
        typeof strategy.weeklyNetRealizedPnl !== "string" ||
        typeof strategy.simulatedFees !== "string") return [];
        return [{
          strategyCode,
          weeklyGrossRealizedPnl: strategy.weeklyGrossRealizedPnl,
          weeklyNetRealizedPnl: strategy.weeklyNetRealizedPnl,
          simulatedFees: strategy.simulatedFees,
        }];
      })
    : [];
  return {
    id: String(row.id),
    customerId: String(row.user_id),
    status: publicPerformanceStatementStatus(String(row.status)),
    cycleStartedAt: timestamp(row.week_start)!,
    cycleEndedAt: timestamp(row.week_end)!,
    currency: "USDT" as const,
    weeklyGrossRealizedPnl:
      typeof snapshot.weeklyGrossRealizedPnl === "string"
        ? snapshot.weeklyGrossRealizedPnl
        : null,
    weeklyNetRealizedPnl: String(row.week_net_pnl),
    simulatedFees:
      typeof snapshot.simulatedFees === "string"
        ? snapshot.simulatedFees
        : null,
    cumulativeNetRealizedPnl: cumulativeNetPnl,
    lossCarry: String(row.loss_carry),
    highWaterMarkBefore: priorHighWaterMark,
    highWaterMarkAfter: prospectiveHighWaterMark,
    settledHighWaterMark: String(row.status) === "paid" || row.paid_at
      ? prospectiveHighWaterMark
      : priorHighWaterMark,
    billableProfit: String(row.eligible_profit),
    feeRate: rate(row.fee_bps),
    feeAmount: String(row.fee_amount),
    strategyBreakdown,
    revision: Number(row.revision ?? 1),
    replacesStatementId: row.replaces_statement_id
      ? String(row.replaces_statement_id)
      : null,
    submittedAt: timestamp(row.submitted_at ?? row.created_at),
    approvedAt: timestamp(row.approved_at),
    paidAt: timestamp(row.paid_at),
    createdAt: timestamp(row.created_at)!,
  };
}

type TimelineInput = {
  statement: Record<string, unknown>;
  decisions: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  receivable: Record<string, unknown> | null;
};

type TimelineEventKind =
  | "STATEMENT_CREATED"
  | "ASSESSMENT_APPROVED"
  | "ASSESSMENT_REJECTED"
  | "RECEIVABLE_CREATED"
  | "PAYMENT_EVIDENCE_RECORDED"
  | "PAYMENT_EVIDENCE_ACCEPTED"
  | "PAYMENT_EVIDENCE_REJECTED"
  | "PAYMENT_APPROVED"
  | "PAYMENT_REJECTED"
  | "STATEMENT_PAID"
  | "NO_FEE_CLOSED";

const timelineEventOrder: Record<TimelineEventKind, number> = {
  STATEMENT_CREATED: 0,
  ASSESSMENT_APPROVED: 10,
  ASSESSMENT_REJECTED: 10,
  RECEIVABLE_CREATED: 20,
  PAYMENT_EVIDENCE_RECORDED: 30,
  PAYMENT_EVIDENCE_ACCEPTED: 40,
  PAYMENT_EVIDENCE_REJECTED: 40,
  PAYMENT_APPROVED: 50,
  PAYMENT_REJECTED: 50,
  STATEMENT_PAID: 60,
  NO_FEE_CLOSED: 60,
};

function timelineTimestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(value as string | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function performanceStatementTimeline(input: TimelineInput) {
  const events: Array<{ id: string; kind: TimelineEventKind; occurredAt: string }> = [];
  const add = (id: string, kind: TimelineEventKind, value: unknown) => {
    const occurredAt = timelineTimestamp(value);
    if (occurredAt) events.push({ id, kind, occurredAt });
  };
  const statementId = String(input.statement.id);
  add(`statement:${statementId}`, "STATEMENT_CREATED", input.statement.created_at);

  for (const decision of input.decisions) {
    const stage = String(decision.stage);
    const decisionValue = String(decision.decision);
    if (stage !== "assessment" && stage !== "payment") continue;
    if (decisionValue !== "approve" && decisionValue !== "reject") continue;
    const prefix = stage === "assessment" ? "ASSESSMENT" : "PAYMENT";
    add(
      `decision:${String(decision.id)}`,
      `${prefix}_${decisionValue === "approve" ? "APPROVED" : "REJECTED"}` as TimelineEventKind,
      decision.created_at,
    );
  }

  if (input.receivable) {
    add(`receivable:${String(input.receivable.id)}`, "RECEIVABLE_CREATED", input.receivable.created_at);
  }
  for (const item of input.evidence) {
    const evidenceId = String(item.id);
    add(`evidence:${evidenceId}:recorded`, "PAYMENT_EVIDENCE_RECORDED", item.created_at);
    if (item.status === "accepted") {
      add(`evidence:${evidenceId}:accepted`, "PAYMENT_EVIDENCE_ACCEPTED", item.reviewed_at);
    } else if (item.status === "rejected") {
      add(`evidence:${evidenceId}:rejected`, "PAYMENT_EVIDENCE_REJECTED", item.reviewed_at);
    }
  }
  if (input.receivable?.paid_at) {
    add(`statement:${statementId}:paid`, "STATEMENT_PAID", input.receivable.paid_at);
  }
  if (input.statement.status === "no_fee") {
    const approved = input.decisions.find((item) => item.stage === "assessment" && item.decision === "approve");
    add(`statement:${statementId}:no-fee`, "NO_FEE_CLOSED", approved?.created_at ?? input.statement.created_at);
  }

  return events.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
      || timelineEventOrder[left.kind] - timelineEventOrder[right.kind]
      || left.id.localeCompare(right.id));
}
export function paymentEvidenceDto(value: unknown) {
  const row = value as Record<string, unknown>,
    referenceFingerprintVersion = String(
      row.reference_fingerprint_version ?? "",
    ),
    status =
      evidenceStatuses[
        String(row.status ?? "recorded") as keyof typeof evidenceStatuses
      ];
  if (!status) throw new Error("UNKNOWN_PAYMENT_EVIDENCE_STATUS");
  if (referenceFingerprintVersion !== PAYMENT_REFERENCE_FINGERPRINT_VERSION)
    throw new Error("UNKNOWN_PAYMENT_REFERENCE_FINGERPRINT_VERSION");
  return {
    id: String(row.id),
    membershipOrderId: row.membership_order_id
      ? String(row.membership_order_id)
      : null,
    performanceStatementId: row.performance_statement_id
      ? String(row.performance_statement_id)
      : null,
    kind: String(row.evidence_kind),
    referenceMasked: String(row.reference_masked),
    amount: String(row.amount),
    currency: String(row.currency),
    occurredAt: timestamp(row.occurred_at)!,
    recordedByUserId: String(row.recorded_by_user_id),
    status,
    reviewedByUserId: row.reviewed_by_user_id
      ? String(row.reviewed_by_user_id)
      : null,
    reviewedAt: timestamp(row.reviewed_at),
    createdAt: timestamp(row.created_at)!,
  };
}
export function membershipActionDto(value: unknown) {
  const row = value as Record<string, unknown>;
  return {
    status: publicMembershipOrderStatus(String(row.status)),
    ...(row.membershipId ? { membershipId: String(row.membershipId) } : {}),
    ...(row.ledgerTransactionId
      ? { ledgerTransactionId: String(row.ledgerTransactionId) }
      : {}),
    ...(row.paymentEvidenceId
      ? { paymentEvidenceId: String(row.paymentEvidenceId) }
      : {}),
    ...(typeof row.replayed === "boolean" ? { replayed: row.replayed } : {}),
  };
}
export function performanceActionDto(value: unknown) {
  const row = value as Record<string, unknown>;
  return {
    status: publicPerformanceStatementStatus(String(row.status)),
    ...(row.ledgerTransactionId
      ? { ledgerTransactionId: String(row.ledgerTransactionId) }
      : {}),
    ...(row.paymentEvidenceId
      ? { paymentEvidenceId: String(row.paymentEvidenceId) }
      : {}),
    ...(typeof row.replayed === "boolean" ? { replayed: row.replayed } : {}),
  };
}
export function cursorPage<T>(
  data: T[],
  limit: number,
  nextCursor: string | null,
) {
  return { data, page: { nextCursor, hasMore: nextCursor !== null, limit } };
}
