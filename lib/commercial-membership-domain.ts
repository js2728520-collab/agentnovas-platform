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

export const requiredLegalDocumentTypes = ["terms", "privacy", "risk_disclosure"] as const;

export function calculateTokenCost(input: {
  modelVersion: string;
  usageReliable: boolean;
  rateReliable: boolean;
  inputTokens: number;
  outputTokens: number;
  inputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
}) {
  if (input.modelVersion !== "token-cost-v1") throw new Error("AI_COST_MODEL_UNSUPPORTED");
  if (!input.usageReliable) throw new Error("AI_USAGE_NOT_RELIABLE");
  if (!input.rateReliable) throw new Error("AI_RATE_NOT_RELIABLE");
  for (const value of [input.inputTokens, input.outputTokens, input.inputCreditsPerMillion, input.outputCreditsPerMillion]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("AI_USAGE_OR_RATE_INVALID");
  }
  const numerator = BigInt(input.inputTokens) * BigInt(input.inputCreditsPerMillion)
    + BigInt(input.outputTokens) * BigInt(input.outputCreditsPerMillion);
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
