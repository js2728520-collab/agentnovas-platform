export const MARKET_PAYLOAD_FRESHNESS_TTL_MS = 30_000;
export const NEWS_CONTENT_FRESHNESS_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type MarketTransportState = "connecting" | "active" | "offline";
export type MarketFeedStatus = "connecting" | "live" | "stale" | "offline";
export type NewsContentFreshness = "fresh" | "stale" | "unknown" | "unavailable";

function timestamp(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function marketPayloadTimestamp(
  value: string | number | Date | null | undefined,
  now = new Date(),
) {
  const parsed = timestamp(value);
  if (parsed === null || parsed > now.getTime() + MAX_CLOCK_SKEW_MS) return null;
  return parsed;
}

export function isRecentMarketPayload(
  value: string | number | Date | null | undefined,
  now = new Date(),
  ttlMs = MARKET_PAYLOAD_FRESHNESS_TTL_MS,
) {
  const parsed = marketPayloadTimestamp(value, now);
  return parsed !== null && now.getTime() - parsed <= ttlMs;
}

export function deriveMarketFeedStatus(input: {
  transport: MarketTransportState;
  payloadAt: string | number | Date | null;
  now?: Date;
  ttlMs?: number;
}): MarketFeedStatus {
  if (input.transport === "offline") return "offline";
  const now = input.now ?? new Date();
  const payloadAt = marketPayloadTimestamp(input.payloadAt, now);
  if (payloadAt === null) return input.transport === "connecting" ? "connecting" : "offline";
  if (now.getTime() - payloadAt > (input.ttlMs ?? MARKET_PAYLOAD_FRESHNESS_TTL_MS)) return "stale";
  return input.transport === "active" ? "live" : "connecting";
}

export function normalizeNewsPublishedAt(value: string | null | undefined) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export function summarizeNewsFreshness(
  publishedDates: Array<string | null>,
  observedAt = new Date(),
  ttlMs = NEWS_CONTENT_FRESHNESS_TTL_MS,
): { freshness: NewsContentFreshness; stale: boolean; newestPublishedAt: string | null } {
  if (publishedDates.length === 0) return { freshness: "unavailable", stale: true, newestPublishedAt: null };
  const observedAtMs = observedAt.getTime();
  const valid = publishedDates.flatMap((value) => {
    const normalized = normalizeNewsPublishedAt(value);
    if (!normalized) return [];
    const parsed = Date.parse(normalized);
    return parsed <= observedAtMs + MAX_CLOCK_SKEW_MS ? [{ normalized, parsed }] : [];
  });
  if (valid.length === 0) return { freshness: "unknown", stale: true, newestPublishedAt: null };
  const newest = valid.reduce((current, candidate) => candidate.parsed > current.parsed ? candidate : current);
  const freshness = observedAtMs - newest.parsed <= ttlMs ? "fresh" : "stale";
  return { freshness, stale: freshness !== "fresh", newestPublishedAt: newest.normalized };
}
