import { STRATEGY_ADMISSION, type StrategyRiskTier } from "./product-parameters.ts";

/**
 * 策略广场准入判定（P-05 / T4.2）。
 *
 * PRD 6.5：「具体门槛按策略类型和市场版本化配置，**不得用口头结论替代**。」因此判定是
 * 确定性的纯函数，输入是回测事实，输出是逐项检查结果——审核人看到的是哪几条不达标，
 * 而不是一个「通过/不通过」的结论。
 *
 * 这里**只判定客观门槛**。人工审核是另一道独立的关（`requiresManualReview`），门槛通过
 * 不等于可以上架。
 */

export const STRATEGY_ADMISSION_CONTRACT_VERSION = 1 as const;

export type StrategyAdmissionThresholds = {
  minimumBacktestDays: number;
  minimumTrades: number;
  /** 净收益必须**超过**这个值。确认值为 0，即「收益为正」；设成 5 就是「必须高于 5%」。 */
  minimumNetReturnPct: number;
  maximumDrawdownPctByTier: Record<StrategyRiskTier, number>;
  requiresPaperTradingPeriod: boolean;
  minimumPaperTradingDays: number;
  requiresManualReview: boolean;
};

export type StrategyAdmissionFacts = {
  riskTier: StrategyRiskTier;
  backtestPeriodStart: string;
  backtestPeriodEnd: string;
  sampleSize: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  paperTradingDays: number;
  /** 回测是否达到标准验证。降级的结果不能当作外部验证已通过（INV-6）。 */
  validationLabel: string;
};

export type StrategyAdmissionCheck = {
  id: string;
  passed: boolean;
  /** 实际值与门槛值，供审核人核对，不只给一个布尔。 */
  actual: number | string;
  required: number | string;
};

export type StrategyAdmissionResult = {
  contractVersion: typeof STRATEGY_ADMISSION_CONTRACT_VERSION;
  /** 所有客观门槛是否全部通过。**不等于可以上架**——人工审核是独立的一关。 */
  meetsThresholds: boolean;
  requiresManualReview: boolean;
  checks: StrategyAdmissionCheck[];
  failedCheckIds: string[];
};

/** 三档风险等级的库内取值与 P-05 档位的映射。 */
const RISK_TIER_BY_LEVEL: Record<string, StrategyRiskTier> = {
  low: "conservative",
  medium: "balanced",
  high: "aggressive",
  conservative: "conservative",
  balanced: "balanced",
  aggressive: "aggressive",
};

/**
 * 未知的 risk_level 归入**最严格**的档位，不是最宽松的。
 *
 * 归入宽松档等于让一个拼错的字段值放宽风控门槛——错误方向应该指向拒绝。
 */
export function riskTierFromLevel(level: string | null | undefined): StrategyRiskTier {
  return RISK_TIER_BY_LEVEL[String(level ?? "").toLowerCase()] ?? "conservative";
}

export function defaultStrategyAdmissionThresholds(): StrategyAdmissionThresholds {
  return {
    minimumBacktestDays: STRATEGY_ADMISSION.minimumBacktestDays,
    minimumTrades: STRATEGY_ADMISSION.minimumTrades,
    minimumNetReturnPct: STRATEGY_ADMISSION.minimumNetReturnPct,
    maximumDrawdownPctByTier: { ...STRATEGY_ADMISSION.maximumDrawdownPctByTier },
    requiresPaperTradingPeriod: STRATEGY_ADMISSION.requiresPaperTradingPeriod,
    minimumPaperTradingDays: STRATEGY_ADMISSION.minimumPaperTradingDays,
    requiresManualReview: STRATEGY_ADMISSION.requiresManualReview,
  };
}

const DAY_MS = 86_400_000;

function backtestDays(start: string, end: string): number | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / DAY_MS);
}

export function evaluateStrategyAdmission(
  facts: StrategyAdmissionFacts,
  thresholds: StrategyAdmissionThresholds = defaultStrategyAdmissionThresholds(),
): StrategyAdmissionResult {
  const checks: StrategyAdmissionCheck[] = [];
  const days = backtestDays(facts.backtestPeriodStart, facts.backtestPeriodEnd);

  // 区间无法解析时按 -1 记，检查必然失败。当成 0 天也会失败，但 -1 让审核人一眼看出
  // 「这不是区间太短，是区间本身有问题」。
  checks.push({
    id: "backtest_period",
    passed: days !== null && days >= thresholds.minimumBacktestDays,
    actual: days ?? -1,
    required: thresholds.minimumBacktestDays,
  });

  checks.push({
    id: "trade_sample",
    passed: Number.isFinite(facts.sampleSize) && facts.sampleSize >= thresholds.minimumTrades,
    actual: Number.isFinite(facts.sampleSize) ? facts.sampleSize : -1,
    required: thresholds.minimumTrades,
  });

  // 严格大于：确认值 0 表达的是「收益为正」，而 0% 不是正数。
  checks.push({
    id: "net_return",
    passed: Number.isFinite(facts.netReturnPct) && facts.netReturnPct > thresholds.minimumNetReturnPct,
    actual: Number.isFinite(facts.netReturnPct) ? facts.netReturnPct : Number.NaN,
    required: thresholds.minimumNetReturnPct,
  });

  const drawdownLimit = thresholds.maximumDrawdownPctByTier[facts.riskTier];
  checks.push({
    id: "max_drawdown",
    passed: Number.isFinite(facts.maxDrawdownPct)
      && Number.isFinite(drawdownLimit)
      && Math.abs(facts.maxDrawdownPct) <= drawdownLimit,
    actual: Number.isFinite(facts.maxDrawdownPct) ? Math.abs(facts.maxDrawdownPct) : Number.NaN,
    required: Number.isFinite(drawdownLimit) ? drawdownLimit : "档位未配置",
  });

  // 降级或未验证的回测不能作为准入依据（INV-6）：那等于把「没验证」记成「验证通过」。
  checks.push({
    id: "validation_label",
    passed: facts.validationLabel === "STANDARD_VERIFIED" || facts.validationLabel === "DEEP_VERIFIED",
    actual: facts.validationLabel || "UNVERIFIED",
    required: "STANDARD_VERIFIED",
  });

  if (thresholds.requiresPaperTradingPeriod) {
    checks.push({
      id: "paper_trading_period",
      passed: Number.isFinite(facts.paperTradingDays)
        && facts.paperTradingDays >= thresholds.minimumPaperTradingDays,
      actual: Number.isFinite(facts.paperTradingDays) ? facts.paperTradingDays : -1,
      required: thresholds.minimumPaperTradingDays,
    });
  }

  const failedCheckIds = checks.filter((check) => !check.passed).map((check) => check.id);
  return {
    contractVersion: STRATEGY_ADMISSION_CONTRACT_VERSION,
    meetsThresholds: failedCheckIds.length === 0,
    requiresManualReview: thresholds.requiresManualReview,
    checks,
    failedCheckIds,
  };
}
