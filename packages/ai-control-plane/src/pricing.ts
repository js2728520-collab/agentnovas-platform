import type { TokenUsage } from "./types.ts";

const SCALE_DIGITS = 12;
const SCALE = BigInt(10) ** BigInt(SCALE_DIGITS);
const PER_MILLION = BigInt(1_000_000);
const exactRatePattern = /^(0|[1-9][0-9]{0,17})(?:\.([0-9]{1,12}))?$/;

function scaledRate(value: string) {
  const match = value.match(exactRatePattern);
  if (!match) throw new Error("AI_RATE_CARD_AMOUNT_INVALID");
  return BigInt(match[1]) * SCALE + BigInt((match[2] ?? "").padEnd(SCALE_DIGITS,"0"));
}

function exactToken(value: number | undefined) {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error("AI_RATE_CARD_USAGE_INVALID");
  return BigInt(normalized);
}

function decimalAmount(value: bigint) {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(SCALE_DIGITS,"0");
  return `${whole}.${fraction}`;
}

/** Calculates an exact, twelve-decimal provider cost without IEEE-754 arithmetic. */
export function calculateProviderCost(input: {
  usage: TokenUsage;
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion?: string | null;
}) {
  if (!/^[A-Z]{3,8}$/.test(input.currency)) throw new Error("AI_RATE_CARD_CURRENCY_INVALID");
  const totalInput = exactToken(input.usage.inputTokens);
  const cachedInput = exactToken(input.usage.cachedInputTokens);
  const nonCachedInput = totalInput > cachedInput ? totalInput - cachedInput : BigInt(0);
  const output = exactToken(input.usage.outputTokens);
  const numerator = nonCachedInput * scaledRate(input.inputPerMillion)
    + output * scaledRate(input.outputPerMillion)
    + cachedInput * scaledRate(input.cachedInputPerMillion ?? input.inputPerMillion);
  const roundedScaledAmount = (numerator + PER_MILLION / BigInt(2)) / PER_MILLION;
  return { currency: input.currency,amount: decimalAmount(roundedScaledAmount) };
}
