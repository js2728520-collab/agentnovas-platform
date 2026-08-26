import {
  normalizeMarketDataId,
  normalizeMarketDataSequence,
  normalizeMarketDataUtcTimestamp,
} from "./market-data.ts";

export type MarketSequencePoint = {
  providerId: string;
  marketId: string;
  instrumentId: string;
  sequence: string;
};

export type MarketSequenceDecision = "accepted" | "duplicate" | "out_of_order" | "scope_mismatch";
export type MarketStreamStatus = "connecting" | "live" | "stale" | "reconnecting" | "offline" | "invalid";

export type MarketCacheUse = {
  quality: "fresh" | "stale" | "invalid";
  ageMs: number | null;
  displayAllowed: boolean;
  displayOnly: boolean;
  eligibleForNewPosition: boolean;
};

const MAX_CLOCK_SKEW_MS = 5_000;
const RECONNECT_TARGET_MS = 10_000;

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw new Error(`${label} is missing field: ${missing}`);
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return input as number;
}

function sequencePoint(input: unknown): MarketSequencePoint {
  const value = record(input, "sequence point");
  exactFields(value, ["providerId", "marketId", "instrumentId", "sequence"], "sequence point");
  return {
    providerId: normalizeMarketDataId(value.providerId, "provider id"),
    marketId: normalizeMarketDataId(value.marketId, "market id"),
    instrumentId: normalizeMarketDataId(value.instrumentId, "instrument id"),
    sequence: normalizeMarketDataSequence(value.sequence),
  };
}

export function advanceMarketSequence(cursorInput: unknown, eventInput: unknown): {
  decision: MarketSequenceDecision;
  cursor: MarketSequencePoint;
} {
  const event = sequencePoint(eventInput);
  if (cursorInput === null) return { decision: "accepted", cursor: event };
  const cursor = sequencePoint(cursorInput);
  if (cursor.providerId !== event.providerId
      || cursor.marketId !== event.marketId
      || cursor.instrumentId !== event.instrumentId) {
    return { decision: "scope_mismatch", cursor };
  }
  const previous = BigInt(cursor.sequence);
  const next = BigInt(event.sequence);
  if (next === previous) return { decision: "duplicate", cursor };
  if (next < previous) return { decision: "out_of_order", cursor };
  return { decision: "accepted", cursor: event };
}

function invalidCacheUse(): MarketCacheUse {
  return {
    quality: "invalid",
    ageMs: null,
    displayAllowed: false,
    displayOnly: true,
    eligibleForNewPosition: false,
  };
}

export function evaluateMarketCacheUse(input: unknown): MarketCacheUse {
  const value = record(input, "market cache input");
  exactFields(value, ["payloadAt", "evaluatedAt", "staleAfterMs"], "market cache input");
  const staleAfterMs = positiveInteger(value.staleAfterMs, "stale threshold");
  let payloadAt: string;
  let evaluatedAt: string;
  try {
    payloadAt = normalizeMarketDataUtcTimestamp(value.payloadAt, "payloadAt");
    evaluatedAt = normalizeMarketDataUtcTimestamp(value.evaluatedAt, "evaluatedAt");
  } catch {
    return invalidCacheUse();
  }
  const ageMs = Date.parse(evaluatedAt) - Date.parse(payloadAt);
  if (ageMs < -MAX_CLOCK_SKEW_MS) return invalidCacheUse();
  const boundedAgeMs = Math.max(0, ageMs);
  if (boundedAgeMs >= staleAfterMs) {
    return {
      quality: "stale",
      ageMs: boundedAgeMs,
      displayAllowed: true,
      displayOnly: true,
      eligibleForNewPosition: false,
    };
  }
  return {
    quality: "fresh",
    ageMs: boundedAgeMs,
    displayAllowed: true,
    displayOnly: false,
    eligibleForNewPosition: true,
  };
}

export function deriveMarketStreamStatus(input: unknown): {
  status: MarketStreamStatus;
  cacheDisplayAllowed: boolean;
  displayOnly: boolean;
  streamFreshEnoughForAdmission: boolean;
} {
  const value = record(input, "market stream input");
  exactFields(value, ["connected", "lastAcceptedAt", "evaluatedAt", "staleAfterMs", "reconnectStartedAt"], "market stream input");
  if (typeof value.connected !== "boolean") throw new Error("connected must be boolean");
  const staleAfterMs = positiveInteger(value.staleAfterMs, "stale threshold");
  let evaluatedAt: string;
  try {
    evaluatedAt = normalizeMarketDataUtcTimestamp(value.evaluatedAt, "evaluatedAt");
  } catch {
    return { status: "invalid", cacheDisplayAllowed: false, displayOnly: true, streamFreshEnoughForAdmission: false };
  }

  const cache = value.lastAcceptedAt === null
    ? invalidCacheUse()
    : evaluateMarketCacheUse({ payloadAt: value.lastAcceptedAt, evaluatedAt, staleAfterMs });

  if (!value.connected) {
    if (value.reconnectStartedAt === null) {
      return {
        status: value.lastAcceptedAt === null ? "connecting" : "offline",
        cacheDisplayAllowed: cache.displayAllowed,
        displayOnly: true,
        streamFreshEnoughForAdmission: false,
      };
    }
    let reconnectStartedAt: string;
    try {
      reconnectStartedAt = normalizeMarketDataUtcTimestamp(value.reconnectStartedAt, "reconnectStartedAt");
    } catch {
      return { status: "invalid", cacheDisplayAllowed: false, displayOnly: true, streamFreshEnoughForAdmission: false };
    }
    const reconnectAgeMs = Date.parse(evaluatedAt) - Date.parse(reconnectStartedAt);
    if (reconnectAgeMs < -MAX_CLOCK_SKEW_MS) {
      return { status: "invalid", cacheDisplayAllowed: false, displayOnly: true, streamFreshEnoughForAdmission: false };
    }
    return {
      status: reconnectAgeMs >= RECONNECT_TARGET_MS ? "offline" : "reconnecting",
      cacheDisplayAllowed: cache.displayAllowed,
      displayOnly: true,
      streamFreshEnoughForAdmission: false,
    };
  }

  if (value.lastAcceptedAt === null) {
    return { status: "connecting", cacheDisplayAllowed: false, displayOnly: true, streamFreshEnoughForAdmission: false };
  }
  if (cache.quality === "invalid") {
    return { status: "invalid", cacheDisplayAllowed: false, displayOnly: true, streamFreshEnoughForAdmission: false };
  }
  return {
    status: cache.quality === "fresh" ? "live" : "stale",
    cacheDisplayAllowed: cache.displayAllowed,
    displayOnly: cache.displayOnly,
    streamFreshEnoughForAdmission: cache.eligibleForNewPosition,
  };
}

export function nextMarketReconnectDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("reconnect attempt must be a non-negative integer");
  if (attempt >= 6) return RECONNECT_TARGET_MS;
  return Math.min(250 * (2 ** attempt), RECONNECT_TARGET_MS);
}
