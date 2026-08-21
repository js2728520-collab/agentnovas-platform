export const tradingHallAgentCatalog = [
  {
    key: "market_analysis",
    sequence: 1,
    name: "市场分析师",
    question: "现在是什么市场？",
    outputName: "市场分析报告",
  },
  {
    key: "technical_analysis",
    sequence: 2,
    name: "技术分析师",
    question: "具体信号是否成立？",
    outputName: "技术信号报告",
  },
  {
    key: "strategy_proposal",
    sequence: 3,
    name: "策略研究员",
    question: "如果交易，应该怎样做？",
    outputName: "候选策略方案",
  },
  {
    key: "adversarial_review",
    sequence: 4,
    name: "反方审查员",
    question: "这个方案为什么可能是错的？",
    outputName: "反方审查报告",
  },
  {
    key: "risk_approval",
    sequence: 5,
    name: "首席风控官",
    question: "这笔交易是否被允许？",
    outputName: "风险审批单",
  },
  {
    key: "final_decision",
    sequence: 6,
    name: "AI 决策官",
    question: "综合所有意见，最终怎么办？",
    outputName: "AI 最终决策单",
  },
  {
    key: "execution_receipt",
    sequence: 7,
    name: "交易执行员",
    question: "如何生成客户 Paper 回执并记录独立的平台 Demo 证据？",
    outputName: "交易执行回执",
  },
] as const;

export type TradingHallAgentKey = typeof tradingHallAgentCatalog[number]["key"];

export type OfficialTradingHallStrategy = {
  code: "ai_conservative" | "ai_balanced" | "ai_aggressive";
  name: string;
  positioning: string;
  targetMarket: "spot_usdt";
  symbols: readonly ("BTCUSDT" | "ETHUSDT" | "SOLUSDT")[];
  regimeTimeframe: "4h" | "1h";
  decisionTimeframes: readonly ("1h" | "15m")[];
  executionObservationTimeframe: "5m";
  typicalHoldingPeriod: string;
  normalParentOrderTarget: { minimum: number; maximum: number };
  risk: {
    maxAssetAllocationPct: number;
    maxTotalAllocationPct: number;
    riskPerTradePct: number;
    dailyLossHaltPct: number;
    maxDrawdownPct: number;
    maxNewEntriesPerDay: number;
    maxConcurrentAssets: 2;
  };
};

export const officialTradingHallStrategies = [
  {
    code: "ai_conservative",
    name: "AI 稳健型",
    positioning: "低频参与明确趋势",
    targetMarket: "spot_usdt",
    symbols: ["BTCUSDT", "ETHUSDT"],
    regimeTimeframe: "4h",
    decisionTimeframes: ["1h"],
    executionObservationTimeframe: "5m",
    typicalHoldingPeriod: "6小时至3天",
    normalParentOrderTarget: { minimum: 3, maximum: 5 },
    risk: {
      maxAssetAllocationPct: 15,
      maxTotalAllocationPct: 25,
      riskPerTradePct: 0.3,
      dailyLossHaltPct: 1,
      maxDrawdownPct: 6,
      maxNewEntriesPerDay: 2,
      maxConcurrentAssets: 2,
    },
  },
  {
    code: "ai_balanced",
    name: "AI 平衡型",
    positioning: "趋势与震荡自适应",
    targetMarket: "spot_usdt",
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    regimeTimeframe: "4h",
    decisionTimeframes: ["1h", "15m"],
    executionObservationTimeframe: "5m",
    typicalHoldingPeriod: "2小时至2天",
    normalParentOrderTarget: { minimum: 5, maximum: 8 },
    risk: {
      maxAssetAllocationPct: 25,
      maxTotalAllocationPct: 50,
      riskPerTradePct: 0.5,
      dailyLossHaltPct: 2,
      maxDrawdownPct: 10,
      maxNewEntriesPerDay: 4,
      maxConcurrentAssets: 2,
    },
  },
  {
    code: "ai_aggressive",
    name: "AI 激进型",
    positioning: "捕捉放量突破与动量",
    targetMarket: "spot_usdt",
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    regimeTimeframe: "1h",
    decisionTimeframes: ["15m"],
    executionObservationTimeframe: "5m",
    typicalHoldingPeriod: "30分钟至12小时",
    normalParentOrderTarget: { minimum: 5, maximum: 10 },
    risk: {
      maxAssetAllocationPct: 35,
      maxTotalAllocationPct: 70,
      riskPerTradePct: 0.8,
      dailyLossHaltPct: 3,
      maxDrawdownPct: 15,
      maxNewEntriesPerDay: 6,
      maxConcurrentAssets: 2,
    },
  },
] as const satisfies readonly OfficialTradingHallStrategy[];

export type TradingHallExecutionMode = "shadow" | "paper" | "mixed_simulation" | "unavailable";
export type TradingHallRoundCompleteness = "complete" | "partial" | "legacy";

export type TradingHallProductBoundary = {
  targetMarket: "spot_usdt";
  symbols: readonly ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  leverageEnabled: false;
  shortSellingEnabled: false;
  realOrderRoutingEnabled: false;
  localExchangeExecutionEnabled: false;
  currentExecutionMode: TradingHallExecutionMode;
  alignmentStatus: "simulation_only";
};

export type TradingHallAgent = typeof tradingHallAgentCatalog[number] & {
  status: "reported" | "waiting" | "legacy_gap";
  latestConclusion: string | null;
  latestUpdatedAt: string | null;
};

export type TradingHallStrategy = OfficialTradingHallStrategy & {
  status: string;
  version: string | null;
  executionMode: TradingHallExecutionMode;
  dataAvailable: boolean;
  openPositions: number;
  lastUpdatedAt: string | null;
  latestDecisionRoundId: string | null;
  latestDecisionStatus: string | null;
};

export type TradingHallDecisionEvent = {
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

export type TradingHallDecisionRound = {
  decisionRoundId: string;
  strategyCode: OfficialTradingHallStrategy["code"];
  strategyName: string;
  strategyVersion: string;
  symbol: string;
  status: string;
  executionMode: TradingHallExecutionMode;
  completeness: TradingHallRoundCompleteness;
  traceId: string | null;
  updatedAt: string | null;
  events: TradingHallDecisionEvent[];
};

export type TradingHallPayload = {
  productBoundary: TradingHallProductBoundary;
  strategies: TradingHallStrategy[];
  agents: TradingHallAgent[];
  decisionRounds: TradingHallDecisionRound[];
  legacyAuditRecords: number;
  generatedAt: string;
};

const runtimeRoleMap: Readonly<Record<string, TradingHallAgentKey | undefined>> = {
  market_data: "market_analysis",
  technical_analysis: "technical_analysis",
  strategy_decision: "strategy_proposal",
  adversarial_review: "adversarial_review",
  risk: "risk_approval",
  decision: "final_decision",
  execution: "execution_receipt",
};

export function tradingHallAgentKeyForRuntimeRole(role: string) {
  return runtimeRoleMap[role];
}

export function tradingHallRoundCompletenessForRuntimeRoles(roles: readonly string[]): TradingHallRoundCompleteness {
  const mapped = new Set(roles.flatMap((role) => {
    const key = tradingHallAgentKeyForRuntimeRole(role);
    return key ? [key] : [];
  }));
  if (mapped.size === tradingHallAgentCatalog.length) return "complete";
  if (roles.includes("audit") && !mapped.has("final_decision")) return "legacy";
  return "partial";
}
