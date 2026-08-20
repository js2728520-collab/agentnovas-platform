import { PAYMENT_REFERENCE_FINGERPRINT_VERSION } from "./commercial-api-support.ts";
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
  return {
    id: String(row.id),
    customerId: String(row.user_id),
    status: publicPerformanceStatementStatus(String(row.status)),
    cycleStartedAt: timestamp(row.week_start)!,
    cycleEndedAt: timestamp(row.week_end)!,
    currency: "USDT" as const,
    cumulativeNetRealizedPnl: String(row.cumulative_net_pnl),
    settledHighWaterMark: String(row.prior_high_water_mark),
    billableProfit: String(row.eligible_profit),
    feeRate: rate(row.fee_bps),
    feeAmount: String(row.fee_amount),
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
    providerLabel: row.provider_label ? String(row.provider_label) : null,
    referenceMasked: String(row.reference_masked),
    amount: String(row.amount),
    currency: String(row.currency),
    occurredAt: timestamp(row.occurred_at)!,
    note: String(row.note ?? ""),
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
