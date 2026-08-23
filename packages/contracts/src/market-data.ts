export const MARKET_DATA_CONTRACT_VERSION = 1 as const;

export type MarketAssetClass = "crypto" | "equity" | "forex" | "metal";
export type MarketRegion = "global" | "us" | "cn" | "hk" | "kr" | "jp";
export type MarketCalendarKind = "continuous" | "provider_managed" | "exchange_managed";
export type MarketCapability = "instrument_search" | "quote_snapshot" | "candle_history" | "realtime_stream";
export type MarketProtocol = "rest" | "websocket";
export type MarketUsage = "display" | "research" | "execution";
export type MarketExecutionPolicy = "display_only" | "paper_only" | "live_gate_required";
export type ProviderAuthorization = "public" | "licensed" | "customer_account";
export type ProviderConnection = "disconnected" | "connected";
export type ProviderHealth = "unknown" | "healthy" | "degraded" | "stale" | "failed";
export type MarketDataQuality = "fresh" | "delayed" | "stale" | "invalid";

export type MarketDescriptor = {
  id: string;
  assetClass: MarketAssetClass;
  region: MarketRegion;
  timezone: string;
  calendar: { id: string; kind: MarketCalendarKind };
  capabilities: MarketCapability[];
  protocols: MarketProtocol[];
  usage: MarketUsage[];
  executionPolicy: MarketExecutionPolicy;
};

export type ProviderDescriptor = {
  id: string;
  name: string;
  authorization: ProviderAuthorization;
  marketIds: string[];
  capabilities: MarketCapability[];
  protocols: MarketProtocol[];
  usage: MarketUsage[];
  configured: boolean;
  connection: ProviderConnection;
  health: ProviderHealth;
  latencyTargetMs: number;
  reconnectTargetMs: number;
  staleAfterMs: number;
};

export type MarketDataFreshness = {
  latencyMs: number | null;
  quality: MarketDataQuality;
  canOpenPosition: boolean;
};

export type MarketDataEventEnvelope = {
  contractVersion: typeof MARKET_DATA_CONTRACT_VERSION;
  providerId: string;
  marketId: string;
  instrumentId: string;
  sequence: string;
  exchangeAt: string;
  receivedAt: string;
  evaluatedAt: string;
  latencyMs: number | null;
  quality: MarketDataQuality;
  canOpenPosition: boolean;
};

const ASSET_CLASSES = ["crypto", "equity", "forex", "metal"] as const;
const REGIONS = ["global", "us", "cn", "hk", "kr", "jp"] as const;
const CALENDAR_KINDS = ["continuous", "provider_managed", "exchange_managed"] as const;
const CAPABILITIES = ["instrument_search", "quote_snapshot", "candle_history", "realtime_stream"] as const;
const PROTOCOLS = ["rest", "websocket"] as const;
const USAGES = ["display", "research", "execution"] as const;
const EXECUTION_POLICIES = ["display_only", "paper_only", "live_gate_required"] as const;
const AUTHORIZATIONS = ["public", "licensed", "customer_account"] as const;
const CONNECTIONS = ["disconnected", "connected"] as const;
const HEALTH_STATES = ["unknown", "healthy", "degraded", "stale", "failed"] as const;
const MAX_CLOCK_SKEW_MS = 5_000;

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

function enumValue<T extends string>(input: unknown, allowed: readonly T[], label: string): T {
  if (typeof input !== "string" || !allowed.includes(input as T)) throw new Error(`${label} is invalid`);
  return input as T;
}

export function normalizeMarketDataId(input: unknown, label = "market data id"): string {
  if (typeof input !== "string" || input.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input)) {
    throw new Error(`${label} must be a stable lowercase id`);
  }
  return input;
}

function sortedUniqueEnum<T extends string>(input: unknown, allowed: readonly T[], label: string): T[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  if (input.length > allowed.length) throw new Error(`${label} has too many values`);
  const values = input.map((item) => enumValue(item, allowed, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values`);
  return [...values].sort();
}

function sortedUniqueIds(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error(`${label} must be a non-empty array`);
  if (input.length > 64) throw new Error(`${label} has too many values`);
  const values = input.map((item) => normalizeMarketDataId(item, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values`);
  return [...values].sort();
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return input as number;
}

export function normalizeMarketDataUtcTimestamp(input: unknown, label = "timestamp"): string {
  if (typeof input !== "string" || !/Z$/.test(input)) throw new Error(`${label} must be an ISO UTC timestamp`);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO UTC timestamp`);
  return new Date(milliseconds).toISOString();
}

export function normalizeMarketDataSequence(input: unknown): string {
  if (typeof input !== "string" || input.length > 128 || !/^(?:0|[1-9][0-9]*)$/.test(input)) {
    throw new Error("sequence must be a canonical non-negative decimal string");
  }
  return input;
}

function timezone(input: unknown): string {
  if (typeof input !== "string" || input.length > 64 || (input !== "UTC" && !input.includes("/"))) {
    throw new Error("timezone must be an IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: input }).format();
  } catch {
    throw new Error("timezone must be an IANA timezone");
  }
  return input;
}

export function normalizeMarketDescriptor(input: unknown): MarketDescriptor {
  const value = record(input, "market descriptor");
  exactFields(value, ["id", "assetClass", "region", "timezone", "calendar", "capabilities", "protocols", "usage", "executionPolicy"], "market descriptor");
  const calendar = record(value.calendar, "calendar");
  exactFields(calendar, ["id", "kind"], "calendar");

  return {
    id: normalizeMarketDataId(value.id, "market id"),
    assetClass: enumValue(value.assetClass, ASSET_CLASSES, "asset class"),
    region: enumValue(value.region, REGIONS, "region"),
    timezone: timezone(value.timezone),
    calendar: {
      id: normalizeMarketDataId(calendar.id, "calendar id"),
      kind: enumValue(calendar.kind, CALENDAR_KINDS, "calendar kind"),
    },
    capabilities: sortedUniqueEnum(value.capabilities, CAPABILITIES, "capabilities"),
    protocols: sortedUniqueEnum(value.protocols, PROTOCOLS, "protocols"),
    usage: sortedUniqueEnum(value.usage, USAGES, "usage"),
    executionPolicy: enumValue(value.executionPolicy, EXECUTION_POLICIES, "execution policy"),
  };
}

export function normalizeProviderDescriptor(input: unknown): ProviderDescriptor {
  const value = record(input, "provider descriptor");
  exactFields(value, ["id", "name", "authorization", "marketIds", "capabilities", "protocols", "usage", "configured", "connection", "health", "latencyTargetMs", "reconnectTargetMs", "staleAfterMs"], "provider descriptor");
  const latencyTargetMs = positiveInteger(value.latencyTargetMs, "latency target");
  const staleAfterMs = positiveInteger(value.staleAfterMs, "stale threshold");
  if (staleAfterMs <= latencyTargetMs) throw new Error("stale threshold must be greater than latency target");
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.trim().length > 120) {
    throw new Error("provider name is invalid");
  }
  if (typeof value.configured !== "boolean") throw new Error("configured must be boolean");

  return {
    id: normalizeMarketDataId(value.id, "provider id"),
    name: value.name.trim(),
    authorization: enumValue(value.authorization, AUTHORIZATIONS, "authorization"),
    marketIds: sortedUniqueIds(value.marketIds, "market ids"),
    capabilities: sortedUniqueEnum(value.capabilities, CAPABILITIES, "capabilities"),
    protocols: sortedUniqueEnum(value.protocols, PROTOCOLS, "protocols"),
    usage: sortedUniqueEnum(value.usage, USAGES, "usage"),
    configured: value.configured,
    connection: enumValue(value.connection, CONNECTIONS, "connection"),
    health: enumValue(value.health, HEALTH_STATES, "health"),
    latencyTargetMs,
    reconnectTargetMs: positiveInteger(value.reconnectTargetMs, "reconnect target"),
    staleAfterMs,
  };
}

export function evaluateMarketDataFreshness(input: {
  exchangeAt: string;
  receivedAt: string;
  evaluatedAt: string;
  latencyTargetMs: number;
  staleAfterMs: number;
}): MarketDataFreshness {
  const exchangeAt = Date.parse(input.exchangeAt);
  const receivedAt = Date.parse(input.receivedAt);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const validThresholds = Number.isSafeInteger(input.latencyTargetMs)
    && input.latencyTargetMs > 0
    && Number.isSafeInteger(input.staleAfterMs)
    && input.staleAfterMs > input.latencyTargetMs;
  if (![exchangeAt, receivedAt, evaluatedAt].every(Number.isFinite)
      || !validThresholds
      || receivedAt - exchangeAt < -MAX_CLOCK_SKEW_MS
      || receivedAt > evaluatedAt
      || evaluatedAt - exchangeAt < -MAX_CLOCK_SKEW_MS) {
    return { latencyMs: null, quality: "invalid", canOpenPosition: false };
  }

  const latencyMs = Math.max(0, receivedAt - exchangeAt);
  if (evaluatedAt - exchangeAt >= input.staleAfterMs) {
    return { latencyMs, quality: "stale", canOpenPosition: false };
  }
  if (latencyMs > input.latencyTargetMs) {
    return { latencyMs, quality: "delayed", canOpenPosition: false };
  }
  return { latencyMs, quality: "fresh", canOpenPosition: true };
}

export function createMarketDataEventEnvelope(input: unknown): MarketDataEventEnvelope {
  const value = record(input, "market data event");
  exactFields(value, ["providerId", "marketId", "instrumentId", "sequence", "exchangeAt", "receivedAt", "evaluatedAt", "latencyTargetMs", "staleAfterMs"], "market data event");
  const sequence = normalizeMarketDataSequence(value.sequence);
  const exchangeAt = normalizeMarketDataUtcTimestamp(value.exchangeAt, "exchangeAt");
  const receivedAt = normalizeMarketDataUtcTimestamp(value.receivedAt, "receivedAt");
  const evaluatedAt = normalizeMarketDataUtcTimestamp(value.evaluatedAt, "evaluatedAt");
  const latencyTargetMs = positiveInteger(value.latencyTargetMs, "latency target");
  const staleAfterMs = positiveInteger(value.staleAfterMs, "stale threshold");
  const freshness = evaluateMarketDataFreshness({ exchangeAt, receivedAt, evaluatedAt, latencyTargetMs, staleAfterMs });

  return {
    contractVersion: MARKET_DATA_CONTRACT_VERSION,
    providerId: normalizeMarketDataId(value.providerId, "provider id"),
    marketId: normalizeMarketDataId(value.marketId, "market id"),
    instrumentId: normalizeMarketDataId(value.instrumentId, "instrument id"),
    sequence,
    exchangeAt,
    receivedAt,
    evaluatedAt,
    ...freshness,
  };
}
