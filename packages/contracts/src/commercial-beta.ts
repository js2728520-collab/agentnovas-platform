export const commercialBetaPlans = [
  { code: "monthly_v1", name: "月卡", priceUsd: "28.00", priceCurrency: "USD", durationDays: 30, aiCredits: 1_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "quarterly_v1", name: "季卡", priceUsd: "58.00", priceCurrency: "USD", durationDays: 90, aiCredits: 3_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "annual_v1", name: "年卡", priceUsd: "198.00", priceCurrency: "USD", durationDays: 365, aiCredits: 12_000, performanceFeeRate: "0.20", isLifetime: false },
  { code: "lifetime_v1", name: "终身会员", priceUsd: "588.00", priceCurrency: "USD", durationDays: null, aiCredits: 36_000, performanceFeeRate: "0.16", isLifetime: true },
] as const;

export const betaPaperCapitalUsdt = "10000.00" as const;
export const platformDemoProviders = ["OKX_DEMO", "BINANCE_SPOT_TESTNET", "BYBIT_DEMO"] as const;
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
  priceCurrency: "USD";
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
