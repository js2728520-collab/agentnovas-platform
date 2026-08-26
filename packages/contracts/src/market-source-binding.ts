import {
  normalizeMarketDataId,
  normalizeMarketDataProviderSymbol,
  type MarketUsage,
  type ProviderAuthorization,
} from "./market-data.ts";

export const MARKET_SOURCE_BINDING_CONTRACT_VERSION = 1 as const;

export type MarketSourceSelection =
  | { mode: "account_aligned"; accountId: string }
  | { mode: "independent"; providerId: string };

export type MarketSourceAccountSnapshot = {
  accountId: string;
  ownerUserId: string;
  providerId: string;
  status: "pending" | "active" | "disconnected" | "revoked";
  canRead: boolean;
};

export type MarketSourceCapabilitySnapshot = {
  capabilityVersionId: string;
  providerId: string;
  marketId: string;
  instrumentId: string;
  providerSymbol: string;
  authorization: ProviderAuthorization;
  usage: MarketUsage[];
  configured: boolean;
  sourceAccountId: string | null;
};

export type ResolvedMarketSourceBinding = {
  contractVersion: typeof MARKET_SOURCE_BINDING_CONTRACT_VERSION;
  strategyVersionId: string;
  selectionMode: MarketSourceSelection["mode"];
  accountId: string | null;
  providerId: string;
  marketId: string;
  instrumentId: string;
  providerSymbol: string;
  requestedUsage: "display" | "research";
  authorization: ProviderAuthorization;
  capabilityVersionId: string;
  sourceAccountId: string | null;
  authorizesOrders: false;
  fingerprintVersion: 1;
  sourcePolicyFingerprint: string;
  bindingInstanceFingerprint: string;
};

export type MarketSourceBindingBlockedReason =
  | "account_required"
  | "account_not_allowed"
  | "account_mismatch"
  | "account_owner_mismatch"
  | "account_unavailable"
  | "source_unavailable"
  | "source_not_configured"
  | "source_account_required"
  | "source_account_mismatch"
  | "provider_mismatch"
  | "scope_mismatch"
  | "usage_unsupported";

export type MarketSourceBindingResolution =
  | { status: "resolved"; reason: "resolved"; binding: ResolvedMarketSourceBinding }
  | { status: "blocked"; reason: MarketSourceBindingBlockedReason; binding: null };

type ResolutionInput = {
  requesterUserId: string;
  strategyVersionId: string;
  marketId: string;
  instrumentId: string;
  requestedUsage: "display" | "research";
  selection: MarketSourceSelection;
  account: MarketSourceAccountSnapshot | null;
  source: MarketSourceCapabilitySnapshot | null;
};

const ACCOUNT_STATUSES = ["pending", "active", "disconnected", "revoked"] as const;
const AUTHORIZATIONS = ["public", "licensed", "customer_account"] as const;
const MARKET_USAGES = ["display", "research", "execution"] as const;
const REQUESTED_USAGES = ["display", "research"] as const;

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

function opaqueId(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    throw new Error(`${label} is invalid`);
  }
  return input;
}

function normalizeUsage(input: unknown): MarketUsage[] {
  if (!Array.isArray(input) || input.length > MARKET_USAGES.length) throw new Error("source usage must be an array");
  const usage = input.map((item) => enumValue(item, MARKET_USAGES, "source usage"));
  if (new Set(usage).size !== usage.length) throw new Error("source usage contains duplicate values");
  return [...usage].sort();
}

export function normalizeMarketSourceSelection(input: unknown): MarketSourceSelection {
  const value = record(input, "market source selection");
  if (value.mode === "account_aligned") {
    exactFields(value, ["mode", "accountId"], "market source selection");
    return { mode: "account_aligned", accountId: opaqueId(value.accountId, "account id") };
  }
  if (value.mode === "independent") {
    exactFields(value, ["mode", "providerId"], "market source selection");
    return { mode: "independent", providerId: normalizeMarketDataId(value.providerId, "provider id") };
  }
  throw new Error("market source selection mode is invalid");
}

function normalizeAccount(input: unknown): MarketSourceAccountSnapshot {
  const value = record(input, "market source account snapshot");
  exactFields(value, ["accountId", "ownerUserId", "providerId", "status", "canRead"], "market source account snapshot");
  if (typeof value.canRead !== "boolean") throw new Error("account canRead must be boolean");
  return {
    accountId: opaqueId(value.accountId, "account id"),
    ownerUserId: opaqueId(value.ownerUserId, "account owner user id"),
    providerId: normalizeMarketDataId(value.providerId, "account provider id"),
    status: enumValue(value.status, ACCOUNT_STATUSES, "account status"),
    canRead: value.canRead,
  };
}

function normalizeSource(input: unknown): MarketSourceCapabilitySnapshot {
  const value = record(input, "market source capability snapshot");
  exactFields(value, [
    "capabilityVersionId",
    "providerId",
    "marketId",
    "instrumentId",
    "providerSymbol",
    "authorization",
    "usage",
    "configured",
    "sourceAccountId",
  ], "market source capability snapshot");
  if (typeof value.configured !== "boolean") throw new Error("source configured must be boolean");
  const authorization = enumValue(value.authorization, AUTHORIZATIONS, "provider authorization");
  const sourceAccountId = value.sourceAccountId === null
    ? null
    : opaqueId(value.sourceAccountId, "source account id");
  if (authorization === "customer_account" && sourceAccountId === null) {
    throw new Error("customer-account source must identify its source account");
  }
  if (authorization !== "customer_account" && sourceAccountId !== null) {
    throw new Error("non-customer source cannot identify a source account");
  }
  return {
    capabilityVersionId: normalizeMarketDataId(value.capabilityVersionId, "capability version id"),
    providerId: normalizeMarketDataId(value.providerId, "provider id"),
    marketId: normalizeMarketDataId(value.marketId, "market id"),
    instrumentId: normalizeMarketDataId(value.instrumentId, "instrument id"),
    providerSymbol: normalizeMarketDataProviderSymbol(value.providerSymbol),
    authorization,
    usage: normalizeUsage(value.usage),
    configured: value.configured,
    sourceAccountId,
  };
}

function normalizeResolutionInput(input: unknown): ResolutionInput {
  const value = record(input, "market source binding input");
  exactFields(value, [
    "requesterUserId",
    "strategyVersionId",
    "marketId",
    "instrumentId",
    "requestedUsage",
    "selection",
    "account",
    "source",
  ], "market source binding input");
  if (!REQUESTED_USAGES.includes(value.requestedUsage as "display" | "research")) {
    throw new Error("requested usage must be display or research");
  }
  return {
    requesterUserId: opaqueId(value.requesterUserId, "requester user id"),
    strategyVersionId: opaqueId(value.strategyVersionId, "strategy version id"),
    marketId: normalizeMarketDataId(value.marketId, "market id"),
    instrumentId: normalizeMarketDataId(value.instrumentId, "instrument id"),
    requestedUsage: value.requestedUsage as "display" | "research",
    selection: normalizeMarketSourceSelection(value.selection),
    account: value.account === null ? null : normalizeAccount(value.account),
    source: value.source === null ? null : normalizeSource(value.source),
  };
}

function blocked(reason: MarketSourceBindingBlockedReason): MarketSourceBindingResolution {
  return Object.freeze({ status: "blocked", reason, binding: null });
}

async function fingerprintTuple(value: Array<string | number | boolean | null>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveMarketSourceBinding(input: unknown): Promise<MarketSourceBindingResolution> {
  const normalized = normalizeResolutionInput(input);
  const { selection, account, source } = normalized;

  if (selection.mode === "independent" && account !== null) return blocked("account_not_allowed");
  if (selection.mode === "account_aligned") {
    if (account === null) return blocked("account_required");
    if (account.accountId !== selection.accountId) return blocked("account_mismatch");
    if (account.ownerUserId !== normalized.requesterUserId) return blocked("account_owner_mismatch");
    if (account.status !== "active" || !account.canRead) return blocked("account_unavailable");
  }
  if (source === null) return blocked("source_unavailable");
  const requestedProviderId = selection.mode === "independent" ? selection.providerId : account!.providerId;
  if (source.providerId !== requestedProviderId) return blocked("provider_mismatch");
  if (source.marketId !== normalized.marketId || source.instrumentId !== normalized.instrumentId) {
    return blocked("scope_mismatch");
  }
  if (!source.configured) return blocked("source_not_configured");
  if (!source.usage.includes(normalized.requestedUsage)) return blocked("usage_unsupported");
  if (source.authorization === "customer_account") {
    if (selection.mode !== "account_aligned") return blocked("source_account_required");
    if (source.sourceAccountId !== selection.accountId) return blocked("source_account_mismatch");
  }

  const sourcePolicyFingerprint = await fingerprintTuple([
    "agentnovas.market-source-policy",
    1,
    source.providerId,
    source.marketId,
    source.instrumentId,
    source.providerSymbol,
    normalized.requestedUsage,
    source.authorization,
    source.capabilityVersionId,
    source.sourceAccountId,
  ]);
  const bindingInstanceFingerprint = await fingerprintTuple([
    "agentnovas.market-source-binding-instance",
    1,
    normalized.strategyVersionId,
    selection.mode,
    selection.mode === "account_aligned" ? selection.accountId : null,
    sourcePolicyFingerprint,
  ]);
  const binding = Object.freeze({
    contractVersion: MARKET_SOURCE_BINDING_CONTRACT_VERSION,
    strategyVersionId: normalized.strategyVersionId,
    selectionMode: selection.mode,
    accountId: selection.mode === "account_aligned" ? selection.accountId : null,
    providerId: source.providerId,
    marketId: source.marketId,
    instrumentId: source.instrumentId,
    providerSymbol: source.providerSymbol,
    requestedUsage: normalized.requestedUsage,
    authorization: source.authorization,
    capabilityVersionId: source.capabilityVersionId,
    sourceAccountId: source.sourceAccountId,
    authorizesOrders: false as const,
    fingerprintVersion: 1 as const,
    sourcePolicyFingerprint,
    bindingInstanceFingerprint,
  });
  return Object.freeze({ status: "resolved", reason: "resolved", binding });
}
