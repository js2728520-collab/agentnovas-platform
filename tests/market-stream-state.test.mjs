import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceMarketSequence,
  deriveMarketStreamStatus,
  evaluateMarketCacheUse,
  nextMarketReconnectDelayMs,
} from "../packages/contracts/src/market-stream.ts";

const first = {
  providerId: "public-binance-market-data",
  marketId: "crypto-global",
  instrumentId: "crypto-btc-usd",
  sequence: "9007199254740993",
};

test("accepts the first sequence and compares later values as arbitrary precision integers", () => {
  const initial = advanceMarketSequence(null, first);
  assert.deepEqual(initial, { decision: "accepted", cursor: first });
  assert.deepEqual(advanceMarketSequence(initial.cursor, { ...first, sequence: "9007199254740994" }), {
    decision: "accepted",
    cursor: { ...first, sequence: "9007199254740994" },
  });
});

test("duplicate and out-of-order events do not advance the cursor", () => {
  assert.deepEqual(advanceMarketSequence(first, first), { decision: "duplicate", cursor: first });
  assert.deepEqual(advanceMarketSequence(first, { ...first, sequence: "9007199254740992" }), {
    decision: "out_of_order",
    cursor: first,
  });
});

test("scope changes fail closed instead of silently resetting sequence", () => {
  assert.deepEqual(advanceMarketSequence(first, { ...first, providerId: "other-provider", sequence: "1" }), {
    decision: "scope_mismatch",
    cursor: first,
  });
  assert.deepEqual(advanceMarketSequence(first, { ...first, instrumentId: "crypto-eth-usd", sequence: "1" }), {
    decision: "scope_mismatch",
    cursor: first,
  });
});

test("rejects non-canonical, negative, oversized, and browser-decorated sequence points", () => {
  assert.throws(() => advanceMarketSequence(null, { ...first, sequence: "01" }), /sequence/i);
  assert.throws(() => advanceMarketSequence(null, { ...first, sequence: "-1" }), /sequence/i);
  assert.throws(() => advanceMarketSequence(null, { ...first, sequence: "9".repeat(129) }), /sequence/i);
  assert.throws(() => advanceMarketSequence(null, { ...first, reset: true }), /unknown field/i);
});

test("fresh cache is displayable while stale cache is display-only and admission-ineligible", () => {
  const input = {
    payloadAt: "2026-08-24T00:00:00.000Z",
    evaluatedAt: "2026-08-24T00:00:29.999Z",
    staleAfterMs: 30_000,
  };
  assert.deepEqual(evaluateMarketCacheUse(input), {
    quality: "fresh",
    ageMs: 29_999,
    displayAllowed: true,
    displayOnly: false,
    eligibleForNewPosition: true,
  });
  assert.deepEqual(evaluateMarketCacheUse({ ...input, evaluatedAt: "2026-08-24T00:00:30.000Z" }), {
    quality: "stale",
    ageMs: 30_000,
    displayAllowed: true,
    displayOnly: true,
    eligibleForNewPosition: false,
  });
});

test("invalid or excessively future cache timestamps cannot be displayed or admitted", () => {
  const expected = {
    quality: "invalid",
    ageMs: null,
    displayAllowed: false,
    displayOnly: true,
    eligibleForNewPosition: false,
  };
  assert.deepEqual(evaluateMarketCacheUse({ payloadAt: "bad", evaluatedAt: "2026-08-24T00:00:00Z", staleAfterMs: 30_000 }), expected);
  assert.deepEqual(evaluateMarketCacheUse({ payloadAt: "2026-08-24T00:00:06Z", evaluatedAt: "2026-08-24T00:00:00Z", staleAfterMs: 30_000 }), expected);
});

test("derives live and stale states only from connection and accepted payload time", () => {
  const input = {
    connected: true,
    lastAcceptedAt: "2026-08-24T00:00:00Z",
    evaluatedAt: "2026-08-24T00:00:01Z",
    staleAfterMs: 30_000,
    reconnectStartedAt: null,
  };
  assert.deepEqual(deriveMarketStreamStatus(input), {
    status: "live",
    cacheDisplayAllowed: true,
    displayOnly: false,
    streamFreshEnoughForAdmission: true,
  });
  assert.deepEqual(deriveMarketStreamStatus({ ...input, evaluatedAt: "2026-08-24T00:00:30Z" }), {
    status: "stale",
    cacheDisplayAllowed: true,
    displayOnly: true,
    streamFreshEnoughForAdmission: false,
  });
});

test("derives reconnecting, offline, connecting, and invalid states without claiming recovery", () => {
  const input = {
    connected: false,
    lastAcceptedAt: "2026-08-24T00:00:00Z",
    evaluatedAt: "2026-08-24T00:00:05Z",
    staleAfterMs: 30_000,
    reconnectStartedAt: "2026-08-24T00:00:01Z",
  };
  assert.equal(deriveMarketStreamStatus(input).status, "reconnecting");
  assert.equal(deriveMarketStreamStatus({ ...input, evaluatedAt: "2026-08-24T00:00:11Z" }).status, "offline");
  assert.equal(deriveMarketStreamStatus({ ...input, reconnectStartedAt: null }).status, "offline");
  assert.equal(deriveMarketStreamStatus({ ...input, connected: true, lastAcceptedAt: null, reconnectStartedAt: null }).status, "connecting");
  assert.equal(deriveMarketStreamStatus({ ...input, lastAcceptedAt: null, reconnectStartedAt: null }).status, "connecting");
  assert.equal(deriveMarketStreamStatus({ ...input, evaluatedAt: "bad" }).status, "invalid");
});

test("uses bounded deterministic reconnect delays with a ten-second ceiling", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 100].map(nextMarketReconnectDelayMs), [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.throws(() => nextMarketReconnectDelayMs(-1), /attempt/i);
  assert.throws(() => nextMarketReconnectDelayMs(1.5), /attempt/i);
});
