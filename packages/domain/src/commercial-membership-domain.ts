const DECIMAL_SCALE = BigInt(18);
const DECIMAL_UNIT = BigInt(10) ** DECIMAL_SCALE;

function decimalToUnits(value: string) {
  const match = /^(-)?(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) throw new Error("INVALID_DECIMAL");
  const units = BigInt(match[2]) * DECIMAL_UNIT + BigInt((match[3] ?? "").padEnd(18, "0"));
  return match[1] ? -units : units;
}

function unitsToDecimal(value: bigint) {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const fraction = (absolute % DECIMAL_UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / DECIMAL_UNIT}${fraction ? `.${fraction}` : ""}`;
}

export function compareSignedDecimalStrings(left:string,right:string){const a=decimalToUnits(left),b=decimalToUnits(right);return a===b?0:a>b?1:-1;}

export const requiredLegalDocumentTypes = [
  "service_entity","jurisdiction","privacy","terms","risk_disclosure",
  "simulated_performance_fee_opinion","refund_policy",
] as const;

export function calculateTokenCost(input: {
  modelVersion: string;
  usageReliable: boolean;
  rateReliable: boolean;
  inputTokens: number;
  outputTokens: number;
}) {
  if (input.modelVersion !== "token-cost-v1") throw new Error("AI_COST_MODEL_UNSUPPORTED");
  if (!input.usageReliable) throw new Error("AI_USAGE_NOT_RELIABLE");
  if (!input.rateReliable) throw new Error("AI_RATE_NOT_RELIABLE");
  const rates={inputCreditsPerMillion:10,outputCreditsPerMillion:30};
  for (const value of [input.inputTokens, input.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("AI_USAGE_OR_RATE_INVALID");
  }
  const numerator = BigInt(input.inputTokens) * BigInt(rates.inputCreditsPerMillion)
    + BigInt(input.outputTokens) * BigInt(rates.outputCreditsPerMillion);
  const credits = (numerator + BigInt(999_999)) / BigInt(1_000_000);
  return { modelVersion: input.modelVersion, credits: credits.toString() };
}

export function calculateWeeklyPerformanceFee(input: {
  weekNetPnl: string;
  cumulativeNetPnl: string;
  committedHighWaterMark: string;
  feeBps: number;
}) {
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000) throw new Error("FEE_BPS_INVALID");
  const cumulative = decimalToUnits(input.cumulativeNetPnl);
  const hwm = decimalToUnits(input.committedHighWaterMark);
  const eligible = cumulative > hwm ? cumulative - hwm : BigInt(0);
  const lossCarry = cumulative < hwm ? hwm - cumulative : BigInt(0);
  const fee = eligible * BigInt(input.feeBps) / BigInt(10_000);
  return {
    weekNetPnl: unitsToDecimal(decimalToUnits(input.weekNetPnl)),
    cumulativeNetPnl: unitsToDecimal(cumulative),
    committedHighWaterMark: unitsToDecimal(hwm),
    eligibleProfit: unitsToDecimal(eligible),
    lossCarry: unitsToDecimal(lossCarry),
    feeAmount: unitsToDecimal(fee),
  };
}

/**
 * 把一笔绩效费拆成平台与作者两份（P-06 / T4.3）。
 *
 * 拆分在**已算好的绩效费**上做，不重新算费：费率、高水位线与周期已经由
 * `calculateWeeklyPerformanceFee` 决定，这里只负责分账。两件事分开，改分账比例才不会
 * 意外改动计费口径。
 *
 * 两条不变量：
 *
 * - **平台份 + 作者份恒等于总额。** 用整数单位做，先算一边再相减，绝不两边各自取整
 *   ——那会漏出一个谁也不属于的尾差，而账本要求借贷必平（INV-4）。
 * - **尾差归作者。** 取整方向必须写死在一处并说明白。让平台承接尾差意味着系统性地
 *   偏向自己一侧，即便每笔只有 1e-18，也是一个不该由实现细节决定的立场。
 *
 * 自用策略不产生平台收入：作者跟自己的策略，平台没有中介角色可言。
 */
export function splitFollowPerformanceFee(input: {
  feeAmount: string;
  platformShareBps: number;
  publicationMode: "marketplace" | "self_use";
}) {
  if (!Number.isInteger(input.platformShareBps) || input.platformShareBps < 0 || input.platformShareBps > 10_000) {
    throw new Error("PLATFORM_SHARE_BPS_INVALID");
  }
  const fee = decimalToUnits(input.feeAmount);
  if (fee < BigInt(0)) throw new Error("FOLLOW_FEE_NEGATIVE");
  if (input.publicationMode === "self_use") {
    return {
      feeAmount: unitsToDecimal(fee),
      platformAmount: unitsToDecimal(BigInt(0)),
      authorAmount: unitsToDecimal(fee),
      eligibleRevenue: unitsToDecimal(BigInt(0)),
    };
  }
  const platform = fee * BigInt(input.platformShareBps) / BigInt(10_000);
  const author = fee - platform;
  return {
    feeAmount: unitsToDecimal(fee),
    platformAmount: unitsToDecimal(platform),
    authorAmount: unitsToDecimal(author),
    // 只有平台那一份进分销收入池；作者那一份是付给作者的成本，不是平台收入。
    eligibleRevenue: unitsToDecimal(platform),
  };
}
