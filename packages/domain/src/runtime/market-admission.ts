import { timeframeMilliseconds } from "./market-cache.ts";

export const RUNTIME_CANDLE_CLOSE_GRACE_MS = 30_000;

export type RuntimeCandleAdmissionInput = {
  latestClosedAt: number;
  evaluatedAt: number;
  timeframe: string;
};

export type RuntimeCandleAdmission = {
  quality: "fresh" | "stale" | "invalid";
  ageMs: number | null;
  staleAfterMs: number | null;
  latestClosedAt: string | null;
  entryAllowed: boolean;
  reason: "latest_closed_candle_stale" | "market_candle_time_invalid" | null;
};

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_TIMESTAMP_MS;
}

function invalidAdmission(staleAfterMs: number | null = null): RuntimeCandleAdmission {
  return {
    quality: "invalid",
    ageMs: null,
    staleAfterMs,
    latestClosedAt: null,
    entryAllowed: false,
    reason: "market_candle_time_invalid",
  };
}

/**
 * Ignore a provider's valid current/incomplete tail before selecting a decision candle.
 * Invalid OHLC/order data is rejected separately by the caller before this filter runs.
 */
export function completedRuntimeCandlesAt<T extends { closeTime: number }>(
  candles: readonly T[],
  evaluatedAt: number,
): T[] {
  if (!validTimestamp(evaluatedAt)) return [];
  return candles.filter((candle) => validTimestamp(candle.closeTime) && candle.closeTime <= evaluatedAt);
}

/**
 * Candle cadence is a necessary admission gate for the current REST runtime. It does not
 * replace stream latency, sequence, connection, or provider failover gates.
 */
export function evaluateRuntimeCandleAdmission(input: RuntimeCandleAdmissionInput): RuntimeCandleAdmission {
  const timeframeMs = timeframeMilliseconds(input.timeframe);
  if (timeframeMs === null) return invalidAdmission();
  const staleAfterMs = timeframeMs + RUNTIME_CANDLE_CLOSE_GRACE_MS;
  if (!validTimestamp(input.latestClosedAt)
      || !validTimestamp(input.evaluatedAt)
      || input.latestClosedAt > input.evaluatedAt) {
    return invalidAdmission(staleAfterMs);
  }
  const ageMs = input.evaluatedAt - input.latestClosedAt;
  const latestClosedAt = new Date(input.latestClosedAt).toISOString();
  if (ageMs >= staleAfterMs) {
    return {
      quality: "stale",
      ageMs,
      staleAfterMs,
      latestClosedAt,
      entryAllowed: false,
      reason: "latest_closed_candle_stale",
    };
  }
  return {
    quality: "fresh",
    ageMs,
    staleAfterMs,
    latestClosedAt,
    entryAllowed: true,
    reason: null,
  };
}
