/**
 * 四档套餐（P-07）。
 *
 * 价格与费率以 `product-parameters.ts` 的 `MEMBERSHIP_PLANS` 为准——那是需求方 2026-08-24
 * 冻结的确认值。这里保留独立字面量是因为本模块还带着面向展示的 name/isLifetime，
 * 由 `tests/commercial-plan-pricing` 与冻结值逐项对齐。
 *
 * **改价不改历史。** 运行时费率来自 `commercial_membership_orders.performance_fee_bps`
 * ——下单时快照。改价要新建 `commercial_plan_versions` 版本并把旧版标 retired，绝不就地
 * 改旧行（INV-5）。
 */
export const commercialBetaPlans = [
  { code: "monthly_v1", name: "月卡", priceUsd: "59.00", priceCurrency: "USDT", durationDays: 30, aiCredits: 1_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "quarterly_v1", name: "季卡", priceUsd: "129.00", priceCurrency: "USDT", durationDays: 90, aiCredits: 3_000, performanceFeeRate: "0.19", isLifetime: false },
  { code: "annual_v1", name: "年卡", priceUsd: "499.00", priceCurrency: "USDT", durationDays: 365, aiCredits: 12_000, performanceFeeRate: "0.18", isLifetime: false },
  { code: "lifetime_v1", name: "终身会员", priceUsd: "1999.00", priceCurrency: "USDT", durationDays: null, aiCredits: 36_000, performanceFeeRate: "0.16", isLifetime: true },
] as const;

export const betaPaperCapitalUsdt = "10000.00" as const;
export const platformDemoProviders = ["OKX_DEMO", "BINANCE_SPOT_TESTNET", "BYBIT_DEMO"] as const;
export const clientDemoProviderCatalog = [
  { provider: "OKX", environment: "OKX_DEMO" },
  { provider: "BINANCE", environment: "BINANCE_SPOT_TESTNET" },
  { provider: "BYBIT", environment: "BYBIT_DEMO" },
] as const;
export const performanceFeeCycle = { cadence: "WEEKLY", timezone: "UTC" } as const;
export const performanceFeeCurrency = "USDT" as const;

export const membershipOrderStatuses = [
  "AWAITING_EVIDENCE",
  "SUBMITTED",
  "REJECTED",
  "ACTIVATED",
  "CANCELLED",
] as const;

export const performanceFeeStatementStatuses = [
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "INVOICED",
  "PAID",
  "CLOSED_NO_FEE",
] as const;

export type CommercialPlanCode = typeof commercialBetaPlans[number]["code"];
export type MembershipOrderStatus = typeof membershipOrderStatuses[number];
export type PerformanceFeeStatementStatus = typeof performanceFeeStatementStatuses[number];
export type PlatformDemoProvider = typeof platformDemoProviders[number];
export type OfficialStrategyCode = "ai_conservative" | "ai_balanced" | "ai_aggressive";
export type ClientDemoProvider = typeof clientDemoProviderCatalog[number]["provider"];
export type ClientDemoEnvironment = typeof clientDemoProviderCatalog[number]["environment"];
export type ClientDemoProviderStatus =
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "PAUSED"
  | "UNVERIFIED"
  | "VERIFIED"
  | "VERIFICATION_FAILED";
export type ClientDemoCardStatus =
  | "NOT_TESTED"
  | "PAUSED"
  | "PENDING"
  | "RUNNING"
  | "UNKNOWN"
  | "RETRY_WAIT"
  | "RECONCILE_WAIT"
  | "FILLED"
  | "CANCELLED"
  | "FAILED"
  | "QUARANTINED";
export type ClientDemoReceiptStatus =
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";

export type ClientDemoReceiptSummary = {
  status: ClientDemoReceiptStatus;
  observedAt: string;
};

export type ClientDemoCardSummary = {
  strategyCode: OfficialStrategyCode;
  status: ClientDemoCardStatus;
  lastTestedAt: string | null;
  receiptSummary: ClientDemoReceiptSummary | null;
};

export type ClientDemoProviderSummary = {
  provider: ClientDemoProvider;
  environment: ClientDemoEnvironment;
  status: ClientDemoProviderStatus;
  lastTestedAt: string | null;
  cards: ClientDemoCardSummary[];
};

export type ClientDemoSummary = {
  customerImpact: false;
  demoFailureAffectsPaper: false;
  providers: ClientDemoProviderSummary[];
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
};

export type CursorPage<T> = {
  data: T[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
  };
};

export type CommercialPlan = {
  code: CommercialPlanCode;
  name: string;
  priceUsd: string;
  priceCurrency: "USDT";
  durationDays: number | null;
  aiCredits: number;
  performanceFeeRate: string;
  isLifetime: boolean;
  version: number;
  isActive: boolean;
};

export type CommercialLegalDocument = {
  id: string;
  type: string;
  version: string | number;
  contentSha256: string;
  locale: string | null;
  contentMarkdown: string | null;
  effectiveAt: string;
};

export type CommercialLegalConsentStatus = {
  requiredLegalDocuments: Array<CommercialLegalDocument & { acceptedAt: string | null }>;
  configurationComplete: boolean;
  consentComplete: boolean;
};

export type MembershipOrder = {
  id: string;
  orderNo: string;
  customerId: string;
  status: MembershipOrderStatus;
  plan: Omit<CommercialPlan, "isActive">;
  legalDocuments: Array<{
    id: string;
    type: string;
    version: string;
    contentSha256: string;
  }>;
  paymentInstructionsStatus: "CONFIGURED" | "UNAVAILABLE";
  submittedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MembershipEntitlement = {
  id: string;
  planCode: CommercialPlanCode | "trial_monthly_equivalent";
  status: "TRIAL" | "ACTIVE" | "GRACE" | "READ_ONLY" | "EXPIRED" | "CANCELLED";
  startsAt: string;
  expiresAt: string | null;
  closeOnly: boolean;
};

export type AiCreditBalance = {
  available: string;
  reserved: string;
  lifetimeGranted: string;
  lifetimeConsumed: string;
  version: string;
  updatedAt: string | null;
};

export type AiCreditLedgerEntry = {
  id: string;
  type: "GRANT" | "RESERVE" | "SETTLE" | "RELEASE" | "ADJUSTMENT" | "EXPIRY";
  amount: string;
  sourceType: string;
  sourceId: string;
  rateVersion: string | null;
  createdAt: string;
};

export type PerformanceFeeStatement = {
  id: string;
  customerId: string;
  status: PerformanceFeeStatementStatus;
  cycleStartedAt: string;
  cycleEndedAt: string;
  currency: typeof performanceFeeCurrency;
  weeklyGrossRealizedPnl: string | null;
  weeklyNetRealizedPnl: string;
  simulatedFees: string | null;
  cumulativeNetRealizedPnl: string;
  lossCarry: string;
  highWaterMarkBefore: string;
  highWaterMarkAfter: string;
  settledHighWaterMark: string;
  billableProfit: string;
  feeRate: string;
  feeAmount: string;
  strategyBreakdown: Array<{
    strategyCode: OfficialStrategyCode;
    weeklyGrossRealizedPnl: string;
    weeklyNetRealizedPnl: string;
    simulatedFees: string;
  }>;
  revision: number;
  replacesStatementId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
};

export const performanceStatementTimelineEventKinds = [
  "STATEMENT_CREATED",
  "ASSESSMENT_APPROVED",
  "ASSESSMENT_REJECTED",
  "RECEIVABLE_CREATED",
  "PAYMENT_EVIDENCE_RECORDED",
  "PAYMENT_EVIDENCE_ACCEPTED",
  "PAYMENT_EVIDENCE_REJECTED",
  "PAYMENT_APPROVED",
  "PAYMENT_REJECTED",
  "STATEMENT_PAID",
  "NO_FEE_CLOSED",
] as const;

export type PerformanceStatementTimelineEvent = {
  id: string;
  kind: typeof performanceStatementTimelineEventKinds[number];
  occurredAt: string;
};

export type ClientPerformanceStatementDetail = {
  statement: PerformanceFeeStatement;
  timeline: PerformanceStatementTimelineEvent[];
};

export type PaperPortfolio = {
  id: string;
  membershipId: string;
  strategyCode: OfficialStrategyCode;
  initialCashUsdt: string;
  cashUsdt: string;
  marketValueUsdt: string;
  equityUsdt: string;
  realizedGrossPnlUsdt: string;
  realizedPnlUsdt: string;
  realizedNetPnlUsdt: string;
  unrealizedPnlUsdt: string;
  feesUsdt: string;
  status: "ACTIVE" | "CLOSE_ONLY" | "READ_ONLY";
  runtime: {
    state: "NOT_STARTED" | "ACTIVE" | "PAUSED" | "ENDED" | "FAILED";
    deploymentId: string | null;
    subscriptionId: string | null;
    mode: "PAPER" | "SHADOW" | null;
    lastCycleSequence: number;
    lastDecisionAt: string | null;
  };
  openPositionCount: number;
  positions: Array<{
    id: string;
    symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
    side: "LONG";
    quantity: string;
    averageEntryPrice: string;
    costBasisUsdt: string;
    entryFeesUsdt: string;
    lastMarkPrice: string;
    unrealizedPnlUsdt: string;
    openedAt: string;
  }>;
  updatedAt: string;
};

export type PaperTrade = {
  id: string;
  portfolioId: string;
  strategyCode: OfficialStrategyCode;
  symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  side: "BUY" | "SELL";
  quantity: string;
  priceUsdt: string;
  notionalUsdt: string;
  feeUsdt: string;
  allocatedEntryFeeUsdt: string;
  realizedGrossPnlUsdt: string;
  realizedNetPnlUsdt: string;
  decisionRoundId: string;
  traceId: string;
  filledAt: string;
};
