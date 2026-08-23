import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  prepareEditableStrategyCandidate,
  strategyCandidateSpecificationsEqual,
} from "../packages/domain/src/editable-strategy-candidate.ts";
import { StrategyDslValidationError } from "../packages/domain/src/strategy-dsl.ts";

const candidate = {
  schemaVersion: 3,
  name: "BTC trend candidate",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: {
    long: {
      entry: { all: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" }] },
      exit: { any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }] },
      stopLossPct: 2,
      takeProfitPct: 4,
    },
  },
  risk: {
    positionSizePct: 3,
    maxDrawdownPct: 10,
    maxDailyLossPct: 2,
    maxConsecutiveLosses: 3,
  },
};

test("formatting and object key order do not invalidate verified candidate evidence", () => {
  const reordered = {
    risk: {
      maxConsecutiveLosses: 3,
      maxDailyLossPct: 2,
      maxDrawdownPct: 10,
      positionSizePct: 3,
    },
    legs: candidate.legs,
    direction: "long_only",
    timeframe: "1h",
    symbol: "BTCUSDT",
    leverage: 1,
    marginMode: "isolated",
    market: "usdt_perpetual",
    name: "BTC trend candidate",
    schemaVersion: 3,
  };

  const prepared = prepareEditableStrategyCandidate({
    candidateSpecification: candidate,
    requestedSpecification: reordered,
    candidateValidationLabel: "STANDARD_VERIFIED",
  });

  assert.equal(strategyCandidateSpecificationsEqual(candidate, reordered), true);
  assert.equal(prepared.edited, false);
  assert.equal(prepared.validationLabel, "STANDARD_VERIFIED");
  assert.equal(prepared.source, "ai_provider");
  assert.deepEqual(prepared.specification, candidate);
});

test("a semantic parameter edit resets validation evidence and records manual provenance", () => {
  const edited = {
    ...candidate,
    risk: { ...candidate.risk, positionSizePct: 4 },
  };

  const prepared = prepareEditableStrategyCandidate({
    candidateSpecification: candidate,
    requestedSpecification: edited,
    candidateValidationLabel: "STANDARD_VERIFIED",
  });

  assert.equal(prepared.edited, true);
  assert.equal(prepared.validationLabel, "UNVERIFIED");
  assert.equal(prepared.source, "manual");
  assert.equal(prepared.specification.risk.positionSizePct, 4);
});

test("unknown fields and out-of-bound edited risk never reach draft persistence", () => {
  assert.throws(
    () => prepareEditableStrategyCandidate({
      candidateSpecification: candidate,
      requestedSpecification: { ...candidate, arbitraryCode: "buy()" },
      candidateValidationLabel: "STANDARD_VERIFIED",
    }),
    StrategyDslValidationError,
  );
  assert.throws(
    () => prepareEditableStrategyCandidate({
      candidateSpecification: candidate,
      requestedSpecification: {
        ...candidate,
        legs: { long: { ...candidate.legs.long, stopLossPct: 12 } },
      },
      candidateValidationLabel: "STANDARD_VERIFIED",
    }),
    /单笔止损必须小于最大回撤限制/,
  );
});

test("candidate save route wires bounded input, deterministic preparation and saved-version replay", async () => {
  const route = await readFile(new URL(
    "../app/api/strategy-research/runs/[id]/candidates/[candidateId]/save/route.client.ts",
    import.meta.url,
  ), "utf8");

  assert.match(route, /readResearchJson\(request\)/);
  assert.match(route, /prepareEditableStrategyCandidate/);
  assert.match(route, /getSavedStrategyDraftForCandidate/);
  assert.match(route, /getOwnedStrategyDraftById/);
  assert.match(route, /strategyCandidateSpecificationsEqual/);
  assert.match(route, /withResearchCandidateSaveLock/);
  assert.match(route, /CANDIDATE_ALREADY_SAVED/);
  assert.match(route, /edited \? "manual" : "ai_provider"/);
  assert.match(route, /specification: prepared\.specification/);
});
