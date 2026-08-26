import assert from "node:assert/strict";
import test from "node:test";

import { arbitrateMarketSources } from "../packages/contracts/src/market-source-arbitration.ts";

const MARKET_ID = "crypto-global";
const INSTRUMENT_ID = "crypto-btc-usd";
const EVALUATED_AT = "2026-08-24T00:00:10.000Z";

function source(providerId, providerSymbol) {
  return { providerId, providerSymbol };
}

function candidate({
  providerId,
  providerSymbol,
  price,
  sequence,
  exchangeAt = "2026-08-24T00:00:09.800Z",
  receivedAt = "2026-08-24T00:00:09.950Z",
  marketId = MARKET_ID,
  instrumentId = INSTRUMENT_ID,
  ...extra
}) {
  return {
    providerId,
    providerSymbol,
    marketId,
    instrumentId,
    sequence,
    exchangeAt,
    receivedAt,
    price,
    latencyTargetMs: 500,
    staleAfterMs: 30_000,
    ...extra,
  };
}

function input(overrides = {}) {
  return {
    policy: {
      marketId: MARKET_ID,
      instrumentId: INSTRUMENT_ID,
      evaluatedAt: EVALUATED_AT,
      sources: [
        source("primary-feed", "BTC-USD"),
        source("fallback-feed", "XBTUSD"),
      ],
      maxPriceDeviationBps: 100,
      minimumAgreementSources: 2,
      referenceMaxAgeMs: 5_000,
      ...overrides.policy,
    },
    candidates: overrides.candidates ?? [
      candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100.00", sequence: "10" }),
      candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100.50", sequence: "20" }),
    ],
    cursors: overrides.cursors ?? [],
    reference: overrides.reference ?? null,
  };
}

function reference(overrides = {}) {
  return {
    providerId: "primary-feed",
    marketId: MARKET_ID,
    instrumentId: INSTRUMENT_ID,
    price: "100",
    observedAt: "2026-08-24T00:00:08.000Z",
    ...overrides,
  };
}

test("selects the highest-priority fresh source only after cross-source price agreement", () => {
  const result = arbitrateMarketSources(input());

  assert.equal(result.status, "selected");
  assert.equal(result.reason, "primary_selected");
  assert.equal(result.eligibleForNewPosition, true);
  assert.equal(result.selected.providerId, "primary-feed");
  assert.equal(result.selected.providerSymbol, "BTC-USD");
  assert.equal(result.selected.priority, 0);
  assert.equal(result.selected.price, "100");
  assert.equal(result.selected.event.quality, "fresh");
  assert.deepEqual(result.candidates.map((item) => [item.providerId, item.decision, item.priceAgreementSources]), [
    ["primary-feed", "eligible", 2],
    ["fallback-feed", "eligible", 2],
  ]);
});

test("fails over to a fresh fallback when the primary is stale and a fresh reference validates price", () => {
  const result = arbitrateMarketSources(input({
    candidates: [
      candidate({
        providerId: "primary-feed",
        providerSymbol: "BTC-USD",
        price: "100",
        sequence: "10",
        exchangeAt: "2026-08-23T23:59:39.999Z",
        receivedAt: "2026-08-23T23:59:40.100Z",
      }),
      candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100.20", sequence: "20" }),
    ],
    reference: reference(),
  }));

  assert.equal(result.status, "selected");
  assert.equal(result.reason, "fallback_selected");
  assert.equal(result.selected.providerId, "fallback-feed");
  assert.equal(result.selected.price, "100.2");
  assert.equal(result.eligibleForNewPosition, true);
  assert.equal(result.candidates.find((item) => item.providerId === "primary-feed").decision, "market_data_stale");
  assert.equal(result.candidates.find((item) => item.providerId === "fallback-feed").referenceMatched, true);
});

test("does not switch when a lone fallback lacks current price-integrity evidence", () => {
  const result = arbitrateMarketSources(input({
    candidates: [
      candidate({
        providerId: "primary-feed",
        providerSymbol: "BTC-USD",
        price: "100",
        sequence: "10",
        exchangeAt: "2026-08-23T23:59:39.999Z",
        receivedAt: "2026-08-23T23:59:40.100Z",
      }),
      candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100.2", sequence: "20" }),
    ],
  }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "price_integrity_unconfirmed");
  assert.equal(result.selected, null);
  assert.equal(result.eligibleForNewPosition, false);
});

test("fails closed when equally supported price clusters disagree", () => {
  const result = arbitrateMarketSources(input({
    policy: {
      sources: [
        source("primary-feed", "BTC-USD"),
        source("fallback-feed", "XBTUSD"),
        source("third-feed", "BTCUSD"),
        source("fourth-feed", "BTC/USD"),
      ],
    },
    candidates: [
      candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100", sequence: "10" }),
      candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100.5", sequence: "20" }),
      candidate({ providerId: "third-feed", providerSymbol: "BTCUSD", price: "200", sequence: "30" }),
      candidate({ providerId: "fourth-feed", providerSymbol: "BTC/USD", price: "200.5", sequence: "40" }),
    ],
  }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "price_integrity_unconfirmed");
  assert.equal(result.eligibleForNewPosition, false);
  assert.deepEqual(result.candidates.map((item) => item.decision), [
    "price_integrity_unconfirmed",
    "price_integrity_unconfirmed",
    "price_integrity_unconfirmed",
    "price_integrity_unconfirmed",
  ]);
});

test("uses exact decimal arithmetic at the configured basis-point boundary", () => {
  const accepted = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "101.0000", sequence: "20" })],
    reference: reference(),
  }));
  assert.equal(accepted.selected.price, "101");

  const rejected = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "101.0001", sequence: "20" })],
    reference: reference(),
  }));
  assert.equal(rejected.status, "unavailable");
  assert.equal(rejected.reason, "price_integrity_unconfirmed");
});

test("rejects duplicate and out-of-order sequences without poisoning another provider", () => {
  const cursors = [
    { providerId: "primary-feed", marketId: MARKET_ID, instrumentId: INSTRUMENT_ID, sequence: "9007199254740993" },
    { providerId: "fallback-feed", marketId: MARKET_ID, instrumentId: INSTRUMENT_ID, sequence: "9007199254740993" },
  ];
  const duplicate = arbitrateMarketSources(input({
    candidates: [
      candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100", sequence: "9007199254740993" }),
      candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100.1", sequence: "9007199254740994" }),
    ],
    cursors,
    reference: reference(),
  }));
  assert.equal(duplicate.selected.providerId, "fallback-feed");
  assert.equal(duplicate.candidates.find((item) => item.providerId === "primary-feed").decision, "sequence_duplicate");

  const outOfOrder = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100", sequence: "9007199254740992" })],
    cursors: [cursors[0]],
    reference: reference(),
  }));
  assert.equal(outOfOrder.status, "unavailable");
  assert.equal(outOfOrder.candidates[0].decision, "sequence_out_of_order");
});

test("keeps sequence cursors scoped to one provider, market, and instrument", () => {
  const result = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "21" })],
    cursors: [{
      providerId: "fallback-feed",
      marketId: "equities-us",
      instrumentId: INSTRUMENT_ID,
      sequence: "20",
    }],
    reference: reference(),
  }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "sequence_integrity_unconfirmed");
  assert.equal(result.candidates[0].decision, "sequence_scope_mismatch");
});

test("requires exact provider symbol and canonical scope before fallback selection", () => {
  const symbolMismatch = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "BTCUSD", price: "100", sequence: "20" })],
    reference: reference(),
  }));
  assert.equal(symbolMismatch.status, "unavailable");
  assert.equal(symbolMismatch.candidates[0].decision, "symbol_mismatch");

  const scopeMismatch = arbitrateMarketSources(input({
    candidates: [candidate({
      providerId: "fallback-feed",
      providerSymbol: "XBTUSD",
      marketId: "equities-us",
      price: "100",
      sequence: "20",
    })],
    reference: reference(),
  }));
  assert.equal(scopeMismatch.status, "unavailable");
  assert.equal(scopeMismatch.candidates[0].decision, "scope_mismatch");
});

test("stale or excessively future references cannot authorize a source switch", () => {
  const stale = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20" })],
    reference: reference({ observedAt: "2026-08-24T00:00:05.000Z" }),
  }));
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.referenceStatus, "stale");

  const future = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20" })],
    reference: reference({ observedAt: "2026-08-24T00:00:15.001Z" }),
  }));
  assert.equal(future.status, "unavailable");
  assert.equal(future.referenceStatus, "invalid");

  const wrongScope = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20" })],
    reference: reference({ instrumentId: "crypto-eth-usd" }),
  }));
  assert.equal(wrongScope.status, "unavailable");
  assert.equal(wrongScope.referenceStatus, "invalid");
});

test("a fallback cannot use its own previous price as independent switch evidence", () => {
  const result = arbitrateMarketSources(input({
    candidates: [candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20" })],
    reference: reference({ providerId: "fallback-feed" }),
  }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "price_integrity_unconfirmed");
  assert.equal(result.candidates[0].referenceMatched, false);
});

test("an event received after the arbitration instant is invalid rather than fresh", () => {
  const result = arbitrateMarketSources(input({
    candidates: [candidate({
      providerId: "fallback-feed",
      providerSymbol: "XBTUSD",
      price: "100",
      sequence: "20",
      exchangeAt: "2026-08-24T00:00:09.800Z",
      receivedAt: "2026-08-24T00:00:10.001Z",
    })],
    reference: reference(),
  }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.candidates[0].decision, "market_data_invalid");
});

test("malformed prices and client-decorated eligibility fail closed", () => {
  for (const invalidCandidate of [
    candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "0", sequence: "20" }),
    candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "NaN", sequence: "20" }),
    candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20", quality: "fresh" }),
    candidate({ providerId: "fallback-feed", providerSymbol: "XBTUSD", price: "100", sequence: "20", canOpenPosition: true }),
  ]) {
    const result = arbitrateMarketSources(input({ candidates: [invalidCandidate], reference: reference() }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.eligibleForNewPosition, false);
    assert.equal(result.candidates[0].decision, "candidate_invalid");
  }
});

test("bounds policies, sources, candidates, cursors, and reference identity", () => {
  assert.throws(() => arbitrateMarketSources(input({ policy: { maxPriceDeviationBps: 0 } })), /price deviation/i);
  assert.throws(() => arbitrateMarketSources(input({ policy: { maxPriceDeviationBps: 1_001 } })), /price deviation/i);
  assert.throws(() => arbitrateMarketSources(input({ policy: { minimumAgreementSources: 3 } })), /agreement sources/i);
  assert.throws(() => arbitrateMarketSources(input({ policy: { unknown: true } })), /unknown field/i);
  assert.throws(() => arbitrateMarketSources(input({
    policy: { sources: Array.from({ length: 9 }, (_, index) => source(`provider-${index}`, `SYMBOL${index}`)) },
  })), /sources/i);
  assert.throws(() => arbitrateMarketSources(input({
    candidates: [
      candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100", sequence: "10" }),
      candidate({ providerId: "primary-feed", providerSymbol: "BTC-USD", price: "100", sequence: "11" }),
    ],
  })), /duplicate candidate/i);
  assert.throws(() => arbitrateMarketSources(input({ reference: reference({ providerId: "unknown-feed" }) })), /reference provider/i);
  assert.throws(() => arbitrateMarketSources(input({
    policy: { sources: [source("primary-feed", "<BTC>"), source("fallback-feed", "XBTUSD")] },
  })), /provider symbol/i);
});

test("does not mutate caller input and reports an empty cycle as unavailable", () => {
  const request = input();
  const snapshot = structuredClone(request);
  arbitrateMarketSources(request);
  assert.deepEqual(request, snapshot);

  const empty = arbitrateMarketSources(input({ candidates: [] }));
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.reason, "no_fresh_source");
  assert.deepEqual(empty.candidates, []);
});
