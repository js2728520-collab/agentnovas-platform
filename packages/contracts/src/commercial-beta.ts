export const commercialBetaPlans = [
  { code: "monthly_v1", name: "月卡", priceUsd: "28.00", durationDays: 30, aiCredits: 1_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "quarterly_v1", name: "季卡", priceUsd: "58.00", durationDays: 90, aiCredits: 3_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "annual_v1", name: "年卡", priceUsd: "198.00", durationDays: 365, aiCredits: 12_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "lifetime_v1", name: "终身会员", priceUsd: "588.00", durationDays: null, aiCredits: 36_000, performanceFeeRate: "0.16", isLifetime: true },
] as const;

export const betaPaperCapitalUsdt = "10000.00" as const;
export const platformDemoProviders = ["OKX_DEMO", "BINANCE_SPOT_TESTNET", "BYBIT_DEMO"] as const;
export const performanceFeeCycle = { cadence: "WEEKLY", timezone: "UTC" } as const;

export const membershipOrderStatuses = [
  "AWAITING_EVIDENCE",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "ACTIVATED",
  "CANCELLED",
] as const;

export const performanceFeeStatementStatuses = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "INVOICED",
  "PAID",
  "VOID",
] as const;

export type CommercialPlanCode = typeof commercialBetaPlans[number]["code"];
export type MembershipOrderStatus = typeof membershipOrderStatuses[number];
export type PerformanceFeeStatementStatus = typeof performanceFeeStatementStatuses[number];
export type PlatformDemoProvider = typeof platformDemoProviders[number];
export type OfficialStrategyCode = "ai_conservative" | "ai_balanced" | "ai_aggressive";

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
  durationDays: number | null;
  aiCredits: number;
  performanceFeeRate: string;
  isLifetime: boolean;
  version: number;
  isActive: boolean;
};

export type MembershipOrder = {
  id: string;
  orderNo: string;
  customerId: string;
  status: MembershipOrderStatus;
  plan: Omit<CommercialPlan, "isActive">;
  legalDocumentVersion: string;
  paymentInstructionsStatus: "CONFIGURED" | "UNAVAILABLE";
  submittedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MembershipEntitlement = {
  id: string;
  planCode: CommercialPlanCode;
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
  updatedAt: string;
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
  currency: "USD";
  cumulativeNetRealizedPnl: string;
  settledHighWaterMark: string;
  billableProfit: string;
  feeRate: string;
  feeAmount: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
};

export type PaperPortfolio = {
  id: string;
  strategyCode: OfficialStrategyCode;
  initialCashUsdt: typeof betaPaperCapitalUsdt;
  cashUsdt: string;
  marketValueUsdt: string;
  realizedPnlUsdt: string;
  unrealizedPnlUsdt: string;
  status: "ACTIVE" | "CLOSE_ONLY" | "READ_ONLY";
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
  feeUsdt: string;
  realizedPnlUsdt: string;
  decisionRoundId: string;
  traceId: string;
  filledAt: string;
};

export type PlatformDemoExecutionReceipt = {
  id: string;
  provider: PlatformDemoProvider;
  strategyCode: OfficialStrategyCode;
  symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  side: "BUY" | "SELL";
  status: "QUEUED" | "SUBMITTED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "FAILED" | "UNKNOWN";
  notionalLimitUsdt: string;
  providerOrderReference: string | null;
  failureCode: string | null;
  decisionRoundId: string;
  traceId: string;
  submittedAt: string | null;
  updatedAt: string;
};

export type MaintenanceDemoAccount = {
  id: string;
  provider: PlatformDemoProvider;
  status: "DISABLED" | "SANDBOX" | "PAUSED";
  hasSecret: boolean;
  isVerified: boolean;
  lastVerifiedAt: string | null;
  lastVerificationCode: string | null;
  updatedAt: string;
};
