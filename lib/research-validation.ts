export type ResearchMode = "quick" | "standard" | "deep";

export const researchModeConfiguration = {
  quick: { candidateBudget: 3, backtestBudget: 12, minimumCandles: 2_000, walkForwardWindows: 1, revisionRounds: 1 },
  standard: { candidateBudget: 6, backtestBudget: 60, minimumCandles: 5_000, walkForwardWindows: 3, revisionRounds: 2 },
  deep: { candidateBudget: 10, backtestBudget: 200, minimumCandles: 10_000, walkForwardWindows: 5, revisionRounds: 2 },
} as const;

export type AdmissionMetrics = {
  netReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sampleSize: number;
  liquidated: boolean;
  riskBoundaryBreached?: boolean;
};

export type ValidationLabel = "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function splitResearchCandles<T>(mode: ResearchMode, candles: readonly T[]) {
  const minimum = researchModeConfiguration[mode].minimumCandles;
  if (candles.length < minimum) throw new Error(`${mode} 模式至少需要 ${minimum.toLocaleString("en-US")} 根完整 K 线`);
  if (mode === "quick") {
    const trainingEnd = Math.floor(candles.length * 0.7);
    return {
      training: candles.slice(0, trainingEnd),
      validation: candles.slice(trainingEnd),
      holdout: [] as T[],
    };
  }
  const trainingEnd = Math.floor(candles.length * 0.6);
  const validationEnd = Math.floor(candles.length * 0.8);
  return {
    training: candles.slice(0, trainingEnd),
    validation: candles.slice(trainingEnd, validationEnd),
    holdout: candles.slice(validationEnd),
  };
}

export function createHoldoutGuard() {
  const claimed = new Set<string>();
  return {
    claim<T>(candidateId: string, holdout: readonly T[] = []) {
      if (claimed.has(candidateId)) throw new Error("最终留出集对每个候选只能运行一次");
      claimed.add(candidateId);
      return holdout.slice();
    },
    hasRun(candidateId: string) {
      return claimed.has(candidateId);
    },
  };
}

export function evaluateCandidateAdmission(input: {
  mode: ResearchMode;
  holdout: AdmissionMetrics;
  walkForward: AdmissionMetrics[];
  stress: AdmissionMetrics;
  maxDrawdownPct: number;
  dataQuality: { isVerifiable: boolean };
}) {
  const reasons: string[] = [];
  const positiveWalks = input.walkForward.filter(item => item.netReturnPct > 0).length;
  const requiredPositiveWalks = Math.ceil(input.walkForward.length * 2 / 3);
  if (input.holdout.netReturnPct <= 0) reasons.push("最终样本外净收益不大于 0");
  if (positiveWalks < requiredPositiveWalks) reasons.push("走查窗口正收益数量不足 2/3");
  if (input.holdout.profitFactor < 1.1) reasons.push("样本外盈亏因子低于 1.1");
  if (input.holdout.sampleSize < 20) reasons.push("样本外已完成交易少于 20 笔");
  if (input.holdout.maxDrawdownPct > input.maxDrawdownPct) reasons.push("样本外最大回撤超过用户限制");
  if (input.stress.maxDrawdownPct > input.maxDrawdownPct) reasons.push("双倍成本/极端行情压力回撤超过用户限制");
  if (input.holdout.liquidated || input.stress.liquidated) reasons.push("回测或压力测试发生模拟爆仓");
  if (input.holdout.riskBoundaryBreached || input.stress.riskBoundaryBreached) reasons.push("触发单日损失或连续亏损熔断边界");
  if (!input.dataQuality.isVerifiable) reasons.push("行情或费率数据质量不足，不能标记为已验证");
  if (input.mode === "quick") reasons.push("快速探索结果仅可用于模拟盘");

  const qualified = input.mode !== "quick" && reasons.length === 0;
  const stabilityRatio = input.walkForward.length ? positiveWalks / input.walkForward.length : 0;
  const score = finite(input.holdout.netReturnPct) * 3
    + Math.min(Math.max(finite(input.holdout.profitFactor), 0), 3) * 15
    + stabilityRatio * 20
    - Math.max(finite(input.holdout.maxDrawdownPct), 0) * 2
    - (input.stress.liquidated ? 50 : 0)
    - (!input.dataQuality.isVerifiable ? 25 : 0);

  return {
    qualified,
    validationLabel: (qualified
      ? "STANDARD_VERIFIED"
      : input.mode === "quick" ? "EXPLORATION_ONLY" : "STANDARD_FAILED") as ValidationLabel,
    score: Number(score.toFixed(4)),
    reasons,
    positiveWalks,
    totalWalks: input.walkForward.length,
  };
}

export function rankResearchCandidates<T extends { qualified: boolean; score: number }>(candidates: T[]) {
  return [...candidates]
    .sort((left, right) => Number(right.qualified) - Number(left.qualified) || right.score - left.score)
    .slice(0, 3)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
