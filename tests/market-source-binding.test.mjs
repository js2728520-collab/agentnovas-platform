import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMarketSourceSelection,
  resolveMarketSourceBinding,
} from "../packages/contracts/src/market-source-binding.ts";

const source = {
  capabilityVersionId: "provider-alpha-crypto-v1",
  providerId: "provider-alpha",
  marketId: "crypto-global",
  instrumentId: "crypto-btc-usd",
  providerSymbol: "XBT/USD",
  authorization: "licensed",
  usage: ["research", "display"],
  configured: true,
  sourceAccountId: null,
};

const account = {
  accountId: "account-a",
  ownerUserId: "customer-a",
  providerId: "provider-alpha",
  status: "active",
  canRead: true,
};

function independentInput(overrides = {}) {
  return {
    requesterUserId: "customer-a",
    strategyVersionId: "strategy-version-a",
    marketId: "crypto-global",
    instrumentId: "crypto-btc-usd",
    requestedUsage: "research",
    selection: { mode: "independent", providerId: "provider-alpha" },
    account: null,
    source,
    ...overrides,
  };
}

function accountAlignedInput(overrides = {}) {
  return {
    ...independentInput(),
    selection: { mode: "account_aligned", accountId: "account-a" },
    account,
    ...overrides,
  };
}

test("independent selection resolves to an immutable binding instance without order authority", async () => {
  const result = await resolveMarketSourceBinding(independentInput());

  assert.equal(result.status, "resolved");
  assert.equal(result.reason, "resolved");
  assert.equal(result.binding.fingerprintVersion, 1);
  assert.match(result.binding.sourcePolicyFingerprint, /^[0-9a-f]{64}$/);
  assert.match(result.binding.bindingInstanceFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.binding, {
    contractVersion: 1,
    strategyVersionId: "strategy-version-a",
    selectionMode: "independent",
    accountId: null,
    providerId: "provider-alpha",
    marketId: "crypto-global",
    instrumentId: "crypto-btc-usd",
    providerSymbol: "XBT/USD",
    requestedUsage: "research",
    authorization: "licensed",
    capabilityVersionId: "provider-alpha-crypto-v1",
    sourceAccountId: null,
    authorizesOrders: false,
    fingerprintVersion: 1,
    sourcePolicyFingerprint: result.binding.sourcePolicyFingerprint,
    bindingInstanceFingerprint: result.binding.bindingInstanceFingerprint,
  });
});

test("account-aligned selection requires the owned active readable account and follows its provider", async () => {
  const result = await resolveMarketSourceBinding(accountAlignedInput());

  assert.equal(result.status, "resolved");
  assert.equal(result.binding.selectionMode, "account_aligned");
  assert.equal(result.binding.accountId, "account-a");
  assert.equal(result.binding.providerId, "provider-alpha");
  assert.equal(result.binding.authorizesOrders, false);
});

test("selection normalization is strict and independent of input field order", () => {
  assert.deepEqual(
    normalizeMarketSourceSelection({ providerId: "provider-alpha", mode: "independent" }),
    { mode: "independent", providerId: "provider-alpha" },
  );
  assert.deepEqual(
    normalizeMarketSourceSelection({ accountId: "account-a", mode: "account_aligned" }),
    { mode: "account_aligned", accountId: "account-a" },
  );
  assert.throws(
    () => normalizeMarketSourceSelection({ mode: "independent", providerId: "provider-alpha", healthy: true }),
    /unknown field: healthy/i,
  );
  assert.throws(
    () => normalizeMarketSourceSelection({ mode: "platform_default" }),
    /mode is invalid/i,
  );
});

test("equivalent normalized bindings have stable versioned fingerprints", async () => {
  const first = await resolveMarketSourceBinding(independentInput({
    source: { ...source, usage: ["research", "display"] },
  }));
  const reordered = await resolveMarketSourceBinding({
    source: { ...source, providerSymbol: " XBT/USD ", usage: ["display", "research"] },
    account: null,
    selection: { providerId: "provider-alpha", mode: "independent" },
    requestedUsage: "research",
    instrumentId: "crypto-btc-usd",
    marketId: "crypto-global",
    strategyVersionId: "strategy-version-a",
    requesterUserId: "customer-a",
  });
  assert.equal(first.binding.sourcePolicyFingerprint, reordered.binding.sourcePolicyFingerprint);
  assert.equal(first.binding.bindingInstanceFingerprint, reordered.binding.bindingInstanceFingerprint);
  assert.equal(first.binding.sourcePolicyFingerprint, "10f4a41d1ad54c5efa35549b9e041cd91b2b2e305e12f3684ef76badb89a58bf");
  assert.equal(first.binding.bindingInstanceFingerprint, "33cf6a7cd65e5f47e960d5479087e3a95146abb6b91e4ada60beef5b0245b40f");
});

test("instance and source-policy fingerprints separate customer provenance from computation semantics", async () => {
  const independent = await resolveMarketSourceBinding(independentInput());
  const aligned = await resolveMarketSourceBinding(accountAlignedInput());
  const mutations = [
    independentInput({ requestedUsage: "display" }),
    independentInput({ source: { ...source, providerSymbol: "BTC.ALPHA" } }),
    independentInput({ source: { ...source, authorization: "public" } }),
    independentInput({ source: { ...source, capabilityVersionId: "provider-alpha-crypto-v2" } }),
    independentInput({
      selection: { mode: "independent", providerId: "provider-beta" },
      source: { ...source, providerId: "provider-beta" },
    }),
    independentInput({
      marketId: "crypto-secondary",
      source: { ...source, marketId: "crypto-secondary" },
    }),
    independentInput({
      instrumentId: "crypto-eth-usd",
      source: { ...source, instrumentId: "crypto-eth-usd" },
    }),
  ];

  assert.equal(independent.binding.sourcePolicyFingerprint, aligned.binding.sourcePolicyFingerprint);
  assert.notEqual(independent.binding.bindingInstanceFingerprint, aligned.binding.bindingInstanceFingerprint);
  for (const mutation of mutations) {
    const changed = await resolveMarketSourceBinding(mutation);
    assert.notEqual(changed.binding.sourcePolicyFingerprint, independent.binding.sourcePolicyFingerprint);
    assert.notEqual(changed.binding.bindingInstanceFingerprint, independent.binding.bindingInstanceFingerprint);
  }
  const changedVersion = await resolveMarketSourceBinding(independentInput({ strategyVersionId: "strategy-version-b" }));
  assert.equal(changedVersion.binding.sourcePolicyFingerprint, independent.binding.sourcePolicyFingerprint);
  assert.notEqual(changedVersion.binding.bindingInstanceFingerprint, independent.binding.bindingInstanceFingerprint);
});

test("resolution does not mutate browser selection or server snapshots", async () => {
  const input = accountAlignedInput();
  const before = structuredClone(input);

  await resolveMarketSourceBinding(input);

  assert.deepEqual(input, before);
});

test("missing or unconfigured source fails closed without a binding or fingerprint", async () => {
  const missing = await resolveMarketSourceBinding(independentInput({ source: null }));
  const unconfigured = await resolveMarketSourceBinding(independentInput({
    source: { ...source, configured: false },
  }));

  assert.deepEqual(missing, { status: "blocked", reason: "source_unavailable", binding: null });
  assert.deepEqual(unconfigured, { status: "blocked", reason: "source_not_configured", binding: null });
  assert.equal(JSON.stringify([missing, unconfigured]).includes("Fingerprint"), false);
});

test("provider, market, instrument, and usage mismatches fail closed", async () => {
  const provider = await resolveMarketSourceBinding(independentInput({
    selection: { mode: "independent", providerId: "provider-beta" },
  }));
  const market = await resolveMarketSourceBinding(independentInput({ marketId: "equities-us" }));
  const instrument = await resolveMarketSourceBinding(independentInput({ instrumentId: "crypto-eth-usd" }));
  const usage = await resolveMarketSourceBinding(independentInput({
    source: { ...source, usage: ["display"] },
  }));

  assert.equal(provider.reason, "provider_mismatch");
  assert.equal(market.reason, "scope_mismatch");
  assert.equal(instrument.reason, "scope_mismatch");
  assert.equal(usage.reason, "usage_unsupported");
  assert.equal([provider, market, instrument, usage].every((item) => item.binding === null), true);
});

test("account-aligned mode rejects absent, mismatched, foreign, inactive, unreadable, or wrong-provider accounts", async () => {
  const absent = await resolveMarketSourceBinding(accountAlignedInput({ account: null }));
  const mismatched = await resolveMarketSourceBinding(accountAlignedInput({
    account: { ...account, accountId: "account-b" },
  }));
  const foreign = await resolveMarketSourceBinding(accountAlignedInput({
    account: { ...account, ownerUserId: "customer-b" },
  }));
  const inactive = await resolveMarketSourceBinding(accountAlignedInput({
    account: { ...account, status: "disconnected" },
  }));
  const unreadable = await resolveMarketSourceBinding(accountAlignedInput({
    account: { ...account, canRead: false },
  }));
  const wrongProvider = await resolveMarketSourceBinding(accountAlignedInput({
    account: { ...account, providerId: "provider-beta" },
  }));

  assert.equal(absent.reason, "account_required");
  assert.equal(mismatched.reason, "account_mismatch");
  assert.equal(foreign.reason, "account_owner_mismatch");
  assert.equal(inactive.reason, "account_unavailable");
  assert.equal(unreadable.reason, "account_unavailable");
  assert.equal(wrongProvider.reason, "provider_mismatch");
});

test("independent mode rejects an account side channel", async () => {
  const result = await resolveMarketSourceBinding(independentInput({ account }));

  assert.deepEqual(result, { status: "blocked", reason: "account_not_allowed", binding: null });
});

test("customer-account authorization is scoped to the exact aligned account", async () => {
  const customerSource = { ...source, authorization: "customer_account", sourceAccountId: "account-a" };
  const independent = await resolveMarketSourceBinding(independentInput({ source: customerSource }));
  const wrongAccount = await resolveMarketSourceBinding(accountAlignedInput({
    source: { ...customerSource, sourceAccountId: "account-b" },
  }));
  const aligned = await resolveMarketSourceBinding(accountAlignedInput({ source: customerSource }));

  assert.deepEqual(independent, { status: "blocked", reason: "source_account_required", binding: null });
  assert.deepEqual(wrongAccount, { status: "blocked", reason: "source_account_mismatch", binding: null });
  assert.equal(aligned.status, "resolved");
  assert.equal(aligned.binding.sourceAccountId, "account-a");
});

test("policy sharing preserves platform-source reuse and isolates customer-account feeds", async () => {
  const accountB = { ...account, accountId: "account-b" };
  const licensedA = await resolveMarketSourceBinding(accountAlignedInput());
  const licensedB = await resolveMarketSourceBinding(accountAlignedInput({
    selection: { mode: "account_aligned", accountId: "account-b" },
    account: accountB,
  }));
  const customerA = await resolveMarketSourceBinding(accountAlignedInput({
    source: { ...source, authorization: "customer_account", sourceAccountId: "account-a" },
  }));
  const customerB = await resolveMarketSourceBinding(accountAlignedInput({
    selection: { mode: "account_aligned", accountId: "account-b" },
    account: accountB,
    source: { ...source, authorization: "customer_account", sourceAccountId: "account-b" },
  }));

  assert.equal(licensedA.binding.sourcePolicyFingerprint, licensedB.binding.sourcePolicyFingerprint);
  assert.notEqual(licensedA.binding.bindingInstanceFingerprint, licensedB.binding.bindingInstanceFingerprint);
  assert.notEqual(customerA.binding.sourcePolicyFingerprint, customerB.binding.sourcePolicyFingerprint);
  assert.notEqual(customerA.binding.bindingInstanceFingerprint, customerB.binding.bindingInstanceFingerprint);
});

test("execution usage cannot be requested through a market source binding", async () => {
  await assert.rejects(
    resolveMarketSourceBinding(independentInput({ requestedUsage: "execution" })),
    /requested usage must be display or research/i,
  );
});

test("untrusted capability fields, duplicate usage, and malformed provider symbols are rejected", async () => {
  await assert.rejects(
    resolveMarketSourceBinding(independentInput({ source: { ...source, healthy: true } })),
    /unknown field: healthy/i,
  );
  await assert.rejects(
    resolveMarketSourceBinding(independentInput({ source: { ...source, usage: ["research", "research"] } })),
    /duplicate/i,
  );
  await assert.rejects(
    resolveMarketSourceBinding(independentInput({ source: { ...source, providerSymbol: "BTC USD<script>" } })),
    /provider symbol is invalid/i,
  );
});

test("top-level context and account snapshots reject unknown fields", async () => {
  await assert.rejects(
    resolveMarketSourceBinding({ ...independentInput(), fallbackProviderId: "coinbase" }),
    /unknown field: fallbackProviderId/i,
  );
  await assert.rejects(
    resolveMarketSourceBinding(accountAlignedInput({ account: { ...account, apiKey: "must-not-exist" } })),
    /unknown field: apiKey/i,
  );
});

test("identifier, enum, boolean, symbol, and nested-shape boundaries are enforced", async () => {
  const boundary = await resolveMarketSourceBinding(independentInput({
    strategyVersionId: "s".repeat(128),
    source: { ...source, providerSymbol: "A".repeat(80) },
  }));
  assert.equal(boundary.status, "resolved");

  await assert.rejects(resolveMarketSourceBinding(independentInput({ strategyVersionId: "s".repeat(129) })), /strategy version id is invalid/i);
  await assert.rejects(resolveMarketSourceBinding(independentInput({ marketId: "m".repeat(81) })), /market id must be/i);
  await assert.rejects(resolveMarketSourceBinding(independentInput({ source: { ...source, providerSymbol: "A".repeat(81) } })), /provider symbol is invalid/i);
  await assert.rejects(resolveMarketSourceBinding(independentInput({ source: { ...source, authorization: "unknown" } })), /provider authorization is invalid/i);
  await assert.rejects(resolveMarketSourceBinding(independentInput({ source: { ...source, configured: "true" } })), /configured must be boolean/i);
  await assert.rejects(resolveMarketSourceBinding(accountAlignedInput({ account: { ...account, status: "unknown" } })), /account status is invalid/i);
  await assert.rejects(resolveMarketSourceBinding(accountAlignedInput({ account: { ...account, canRead: 1 } })), /canRead must be boolean/i);
  await assert.rejects(resolveMarketSourceBinding(independentInput({ source: [] })), /must be an object/i);
  const missingVersion = { ...source };
  delete missingVersion.capabilityVersionId;
  await assert.rejects(resolveMarketSourceBinding(independentInput({ source: missingVersion })), /missing field: capabilityVersionId/i);
});

test("the contract is provider-independent and has no named-provider fallback", async () => {
  const result = await resolveMarketSourceBinding(independentInput({
    selection: { mode: "independent", providerId: "provider-beta" },
    source: {
      ...source,
      capabilityVersionId: "provider-beta-crypto-v7",
      providerId: "provider-beta",
      providerSymbol: "BTC.BETA",
      authorization: "public",
    },
  }));

  assert.equal(result.status, "resolved");
  assert.equal(result.binding.providerId, "provider-beta");
  assert.equal(result.binding.providerSymbol, "BTC.BETA");
  assert.equal("fallback" in result.binding, false);
});
