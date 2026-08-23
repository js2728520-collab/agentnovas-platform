import {
  createMarketDataEventEnvelope,
  normalizeMarketDataId,
  normalizeMarketDataUtcTimestamp,
  type MarketDataEventEnvelope,
  type MarketDataQuality,
} from "./market-data.ts";
import {
  advanceMarketSequence,
  type MarketSequenceDecision,
  type MarketSequencePoint,
} from "./market-stream.ts";

export type MarketSourceCandidateDecision =
  | "eligible"
  | "candidate_invalid"
  | "symbol_mismatch"
  | "scope_mismatch"
  | "sequence_duplicate"
  | "sequence_out_of_order"
  | "sequence_scope_mismatch"
  | "market_data_invalid"
  | "market_data_delayed"
  | "market_data_stale"
  | "price_integrity_unconfirmed";

export type MarketSourceArbitrationCandidate = {
  providerId: string;
  decision: MarketSourceCandidateDecision;
  quality: MarketDataQuality;
  sequenceDecision: MarketSequenceDecision | null;
  priceAgreementSources: number;
  referenceMatched: boolean;
};

export type MarketSourceArbitrationResult = {
  status: "selected" | "unavailable";
  reason:
    | "primary_selected"
    | "fallback_selected"
    | "no_fresh_source"
    | "sequence_integrity_unconfirmed"
    | "price_integrity_unconfirmed";
  selected: {
    providerId: string;
    providerSymbol: string;
    priority: number;
    price: string;
    event: MarketDataEventEnvelope;
  } | null;
  eligibleForNewPosition: boolean;
  referenceStatus: "absent" | "fresh" | "stale" | "invalid";
  candidates: MarketSourceArbitrationCandidate[];
};

type Decimal = {
  normalized: string;
  units: bigint;
  scale: number;
};

type SourcePolicy = {
  providerId: string;
  providerSymbol: string;
};

type NormalizedPolicy = {
  marketId: string;
  instrumentId: string;
  evaluatedAt: string;
  sources: SourcePolicy[];
  maxPriceDeviationBps: number;
  minimumAgreementSources: number;
  referenceMaxAgeMs: number;
};

type CandidateEvaluation = {
  providerId: string;
  providerSymbol: string;
  priority: number;
  price: Decimal;
  event: MarketDataEventEnvelope;
  sequenceDecision: MarketSequenceDecision;
};

const MAX_SOURCES = 8;
const MAX_PRICE_DEVIATION_BPS = 1_000;
const MAX_REFERENCE_AGE_MS = 300_000;
const CANDIDATE_FIELDS = [
  "providerId",
  "providerSymbol",
  "marketId",
  "instrumentId",
  "sequence",
  "exchangeAt",
  "receivedAt",
  "price",
  "latencyTargetMs",
  "staleAfterMs",
] as const;

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

function boundedInteger(input: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < minimum || Number(input) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(input);
}

function providerSymbol(input: unknown): string {
  if (typeof input !== "string") throw new Error("provider symbol must be a string");
  const normalized = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(normalized)) {
    throw new Error("provider symbol is invalid");
  }
  return normalized;
}

function decimal(input: unknown): Decimal {
  if (typeof input !== "string"
      || input.length > 64
      || !/^(?:0|[1-9][0-9]{0,31})(?:\.[0-9]{1,18})?$/.test(input)) {
    throw new Error("price must be a bounded positive decimal string");
  }
  const [whole, rawFraction = ""] = input.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  const digits = `${whole}${fraction}`;
  const units = BigInt(digits);
  if (units <= BigInt(0)) throw new Error("price must be greater than zero");
  return { normalized, units, scale: fraction.length };
}

function scalePair(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.units * (BigInt(10) ** BigInt(scale - left.scale)),
    right: right.units * (BigInt(10) ** BigInt(scale - right.scale)),
  };
}

function peersWithinDeviation(left: Decimal, right: Decimal, maximumBps: number) {
  const scaled = scalePair(left, right);
  const difference = scaled.left >= scaled.right
    ? scaled.left - scaled.right
    : scaled.right - scaled.left;
  const conservativeBase = scaled.left <= scaled.right ? scaled.left : scaled.right;
  return difference * BigInt(10_000) <= conservativeBase * BigInt(maximumBps);
}

function referenceWithinDeviation(candidate: Decimal, reference: Decimal, maximumBps: number) {
  const scaled = scalePair(candidate, reference);
  const difference = scaled.left >= scaled.right
    ? scaled.left - scaled.right
    : scaled.right - scaled.left;
  return difference * BigInt(10_000) <= scaled.right * BigInt(maximumBps);
}

function normalizePolicy(input: unknown): NormalizedPolicy {
  const value = record(input, "market source policy");
  exactFields(value, [
    "marketId",
    "instrumentId",
    "evaluatedAt",
    "sources",
    "maxPriceDeviationBps",
    "minimumAgreementSources",
    "referenceMaxAgeMs",
  ], "market source policy");
  if (!Array.isArray(value.sources) || value.sources.length < 2 || value.sources.length > MAX_SOURCES) {
    throw new Error(`sources must contain 2 through ${MAX_SOURCES} entries`);
  }
  const sources = value.sources.map((inputSource) => {
    const item = record(inputSource, "market source policy entry");
    exactFields(item, ["providerId", "providerSymbol"], "market source policy entry");
    return {
      providerId: normalizeMarketDataId(item.providerId, "provider id"),
      providerSymbol: providerSymbol(item.providerSymbol),
    };
  });
  if (new Set(sources.map((source) => source.providerId)).size !== sources.length) {
    throw new Error("sources contain duplicate provider ids");
  }
  const minimumAgreementSources = boundedInteger(
    value.minimumAgreementSources,
    2,
    sources.length,
    "minimum agreement sources",
  );
  return {
    marketId: normalizeMarketDataId(value.marketId, "market id"),
    instrumentId: normalizeMarketDataId(value.instrumentId, "instrument id"),
    evaluatedAt: normalizeMarketDataUtcTimestamp(value.evaluatedAt, "evaluatedAt"),
    sources,
    maxPriceDeviationBps: boundedInteger(
      value.maxPriceDeviationBps,
      1,
      MAX_PRICE_DEVIATION_BPS,
      "maximum price deviation",
    ),
    minimumAgreementSources,
    referenceMaxAgeMs: boundedInteger(value.referenceMaxAgeMs, 1, MAX_REFERENCE_AGE_MS, "reference maximum age"),
  };
}

function normalizeCursors(input: unknown, policy: NormalizedPolicy): Map<string, MarketSequencePoint> {
  if (!Array.isArray(input) || input.length > policy.sources.length) throw new Error("cursors exceed the source limit");
  const cursors = new Map<string, MarketSequencePoint>();
  const allowedProviders = new Set(policy.sources.map((source) => source.providerId));
  for (const rawCursor of input) {
    const normalized = advanceMarketSequence(null, rawCursor).cursor;
    if (!allowedProviders.has(normalized.providerId)) throw new Error("cursor provider is not present in the source policy");
    if (cursors.has(normalized.providerId)) throw new Error("cursors contain a duplicate provider");
    cursors.set(normalized.providerId, normalized);
  }
  return cursors;
}

function normalizeReference(input: unknown, policy: NormalizedPolicy): {
  status: "absent" | "fresh" | "stale" | "invalid";
  providerId: string | null;
  price: Decimal | null;
} {
  if (input === null) return { status: "absent", providerId: null, price: null };
  const value = record(input, "market source reference");
  exactFields(value, ["providerId", "marketId", "instrumentId", "price", "observedAt"], "market source reference");
  const allowedProviders = new Set(policy.sources.map((source) => source.providerId));
  const referenceProviderId = normalizeMarketDataId(value.providerId, "reference provider id");
  if (!allowedProviders.has(referenceProviderId)) throw new Error("reference provider is not present in the source policy");
  try {
    const marketId = normalizeMarketDataId(value.marketId, "reference market id");
    const instrumentId = normalizeMarketDataId(value.instrumentId, "reference instrument id");
    const observedAt = normalizeMarketDataUtcTimestamp(value.observedAt, "reference observedAt");
    const normalizedPrice = decimal(value.price);
    if (marketId !== policy.marketId || instrumentId !== policy.instrumentId) {
      return { status: "invalid", providerId: referenceProviderId, price: null };
    }
    const ageMs = Date.parse(policy.evaluatedAt) - Date.parse(observedAt);
    if (ageMs < 0) return { status: "invalid", providerId: referenceProviderId, price: null };
    if (ageMs >= policy.referenceMaxAgeMs) return { status: "stale", providerId: referenceProviderId, price: null };
    return { status: "fresh", providerId: referenceProviderId, price: normalizedPrice };
  } catch {
    return { status: "invalid", providerId: referenceProviderId, price: null };
  }
}

function sequenceRejection(decision: MarketSequenceDecision): MarketSourceCandidateDecision | null {
  if (decision === "duplicate") return "sequence_duplicate";
  if (decision === "out_of_order") return "sequence_out_of_order";
  if (decision === "scope_mismatch") return "sequence_scope_mismatch";
  return null;
}

function qualityRejection(quality: MarketDataQuality): MarketSourceCandidateDecision | null {
  if (quality === "invalid") return "market_data_invalid";
  if (quality === "delayed") return "market_data_delayed";
  if (quality === "stale") return "market_data_stale";
  return null;
}

function candidateResult(
  providerId: string,
  decision: MarketSourceCandidateDecision,
  quality: MarketDataQuality = "invalid",
  sequenceDecision: MarketSequenceDecision | null = null,
): MarketSourceArbitrationCandidate {
  return {
    providerId,
    decision,
    quality,
    sequenceDecision,
    priceAgreementSources: 0,
    referenceMatched: false,
  };
}

export function arbitrateMarketSources(input: unknown): MarketSourceArbitrationResult {
  const value = record(input, "market source arbitration input");
  exactFields(value, ["policy", "candidates", "cursors", "reference"], "market source arbitration input");
  const policy = normalizePolicy(value.policy);
  if (!Array.isArray(value.candidates) || value.candidates.length > policy.sources.length) {
    throw new Error("candidates exceed the source limit");
  }

  const sourceByProvider = new Map(policy.sources.map((source, priority) => [source.providerId, { ...source, priority }]));
  const rawProviderIds = value.candidates.map((rawCandidate) => {
    const item = record(rawCandidate, "market source candidate");
    const providerId = normalizeMarketDataId(item.providerId, "candidate provider id");
    if (!sourceByProvider.has(providerId)) throw new Error("candidate provider is not present in the source policy");
    return providerId;
  });
  if (new Set(rawProviderIds).size !== rawProviderIds.length) throw new Error("duplicate candidate provider");

  const cursors = normalizeCursors(value.cursors, policy);
  const reference = normalizeReference(value.reference, policy);
  const decisions = new Map<string, MarketSourceArbitrationCandidate>();
  const candidates: CandidateEvaluation[] = [];

  value.candidates.forEach((rawCandidate, index) => {
    const providerId = rawProviderIds[index];
    const expected = sourceByProvider.get(providerId)!;
    try {
      const item = record(rawCandidate, "market source candidate");
      exactFields(item, CANDIDATE_FIELDS, "market source candidate");
      const actualSymbol = providerSymbol(item.providerSymbol);
      if (actualSymbol !== expected.providerSymbol) {
        decisions.set(providerId, candidateResult(providerId, "symbol_mismatch"));
        return;
      }
      const marketId = normalizeMarketDataId(item.marketId, "candidate market id");
      const instrumentId = normalizeMarketDataId(item.instrumentId, "candidate instrument id");
      if (marketId !== policy.marketId || instrumentId !== policy.instrumentId) {
        decisions.set(providerId, candidateResult(providerId, "scope_mismatch"));
        return;
      }
      const normalizedPrice = decimal(item.price);
      const event = createMarketDataEventEnvelope({
        providerId,
        marketId,
        instrumentId,
        sequence: item.sequence,
        exchangeAt: item.exchangeAt,
        receivedAt: item.receivedAt,
        evaluatedAt: policy.evaluatedAt,
        latencyTargetMs: item.latencyTargetMs,
        staleAfterMs: item.staleAfterMs,
      });
      const sequence = advanceMarketSequence(cursors.get(providerId) ?? null, {
        providerId,
        marketId,
        instrumentId,
        sequence: event.sequence,
      });
      const rejectedSequence = sequenceRejection(sequence.decision);
      if (rejectedSequence) {
        decisions.set(providerId, candidateResult(providerId, rejectedSequence, event.quality, sequence.decision));
        return;
      }
      const rejectedQuality = qualityRejection(event.quality);
      if (rejectedQuality) {
        decisions.set(providerId, candidateResult(providerId, rejectedQuality, event.quality, sequence.decision));
        return;
      }
      candidates.push({
        providerId,
        providerSymbol: expected.providerSymbol,
        priority: expected.priority,
        price: normalizedPrice,
        event,
        sequenceDecision: sequence.decision,
      });
    } catch {
      decisions.set(providerId, candidateResult(providerId, "candidate_invalid"));
    }
  });

  const agreementCountByProvider = new Map(candidates.map((candidate) => [
    candidate.providerId,
    candidates.filter((peer) =>
      peersWithinDeviation(candidate.price, peer.price, policy.maxPriceDeviationBps)).length,
  ]));
  const maximumAgreementSources = Math.max(0, ...agreementCountByProvider.values());
  const strongestConsensusCandidates = candidates.filter((candidate) =>
    agreementCountByProvider.get(candidate.providerId) === maximumAgreementSources
      && maximumAgreementSources >= policy.minimumAgreementSources);
  const strongestConsensusIsUnambiguous = strongestConsensusCandidates.length > 0
    && strongestConsensusCandidates.every((candidate, index) =>
      strongestConsensusCandidates.slice(index + 1).every((peer) =>
        peersWithinDeviation(candidate.price, peer.price, policy.maxPriceDeviationBps)));

  const eligible: CandidateEvaluation[] = [];
  for (const candidate of candidates) {
    const priceAgreementSources = agreementCountByProvider.get(candidate.providerId)!;
    const referenceMatched = reference.status === "fresh"
      && reference.price !== null
      && reference.providerId !== candidate.providerId
      && referenceWithinDeviation(candidate.price, reference.price, policy.maxPriceDeviationBps);
    const peerConsensusMatched = strongestConsensusIsUnambiguous
      && priceAgreementSources === maximumAgreementSources;
    const priceConfirmed = peerConsensusMatched || referenceMatched;
    decisions.set(candidate.providerId, {
      providerId: candidate.providerId,
      decision: priceConfirmed ? "eligible" : "price_integrity_unconfirmed",
      quality: candidate.event.quality,
      sequenceDecision: candidate.sequenceDecision,
      priceAgreementSources,
      referenceMatched,
    });
    if (priceConfirmed) eligible.push(candidate);
  }

  const orderedDecisions = [...decisions.values()].sort((left, right) =>
    sourceByProvider.get(left.providerId)!.priority - sourceByProvider.get(right.providerId)!.priority);
  const selected = eligible.sort((left, right) => left.priority - right.priority)[0] ?? null;
  if (selected) {
    return {
      status: "selected",
      reason: selected.priority === 0 ? "primary_selected" : "fallback_selected",
      selected: {
        providerId: selected.providerId,
        providerSymbol: selected.providerSymbol,
        priority: selected.priority,
        price: selected.price.normalized,
        event: selected.event,
      },
      eligibleForNewPosition: true,
      referenceStatus: reference.status,
      candidates: orderedDecisions,
    };
  }

  const reason = orderedDecisions.some((candidate) => candidate.decision === "price_integrity_unconfirmed")
    ? "price_integrity_unconfirmed"
    : orderedDecisions.some((candidate) => candidate.decision.startsWith("sequence_"))
      ? "sequence_integrity_unconfirmed"
      : "no_fresh_source";
  return {
    status: "unavailable",
    reason,
    selected: null,
    eligibleForNewPosition: false,
    referenceStatus: reference.status,
    candidates: orderedDecisions,
  };
}
