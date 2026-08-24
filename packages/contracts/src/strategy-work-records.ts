import type { TradingHallAgentKey, TradingHallRoundCompleteness } from "./trading-hall.ts";

export type StrategyWorkRecordAdmissionStatus = "not_required" | "not_recorded" | "recorded" | "risk_rejected" | "failed";

export type StrategyWorkRecordSummary = {
  recordId: string;
  strategyCode: "ai_conservative" | "ai_balanced" | "ai_aggressive";
  strategyName: string;
  strategyVersion: string;
  symbol: string;
  timeframe: string;
  decisionStatus: string;
  completeness: TradingHallRoundCompleteness;
  executionMode: "shadow" | "paper";
  admissionStatus: StrategyWorkRecordAdmissionStatus;
  hasOrderIntent: boolean;
  hasFillReceipt: boolean;
  occurredAt: string;
  isSharedDecision: boolean;
};

export type StrategyWorkRecordEvent = {
  sequence: number;
  role: TradingHallAgentKey | "legacy_audit";
  name: string;
  outputName: string;
  conclusion: string;
  evidence: Record<string, unknown>;
  llmUsed: boolean;
  explanationStatus: string;
  explanation: string | null;
  createdAt: string;
};

export type StrategyWorkRecordMarketSnapshot = {
  exchange: string;
  symbol: string;
  timeframe: string;
  dataStart: string;
  dataEnd: string;
  candleCount: number;
  datasetSha256: string;
  dataQuality: Record<string, string | number | boolean | null>;
};

export type StrategyWorkRecordAdmission = {
  status: StrategyWorkRecordAdmissionStatus;
  cycleId: string | null;
  cycleStatus: string | null;
  decision: Record<string, unknown> | null;
  completedAt: string | null;
};

export type StrategyWorkRecordOrderIntent = {
  id: string;
  action: "buy" | "sell";
  executionTiming: string;
  requestedPrice: string | null;
  status: string;
  rejectionCode: string | null;
  createdAt: string;
  filledAt: string | null;
};

export type StrategyWorkRecordFillReceipt = {
  id: string;
  intentId: string;
  action: "buy" | "sell";
  quantity: string;
  fillPrice: string;
  notionalUsdt: string;
  feeUsdt: string;
  realizedGrossPnlUsdt: string;
  realizedNetPnlUsdt: string;
  filledAt: string;
};

export type StrategyWorkRecordDetail = StrategyWorkRecordSummary & {
  candleOpenAt: string;
  traceId: string | null;
  sharedDecisionRoundId: string | null;
  marketSnapshot: StrategyWorkRecordMarketSnapshot | null;
  events: StrategyWorkRecordEvent[];
  admission: StrategyWorkRecordAdmission;
  orderIntents: StrategyWorkRecordOrderIntent[];
  fillReceipts: StrategyWorkRecordFillReceipt[];
  realOrderRoutingEnabled: false;
};

export type StrategyWorkRecordPage = {
  data: StrategyWorkRecordSummary[];
  page: { limit: number; nextCursor: string | null };
};
