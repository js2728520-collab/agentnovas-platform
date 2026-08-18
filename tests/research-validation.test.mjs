import assert from "node:assert/strict";
import test from "node:test";

import {
  createHoldoutGuard,
  evaluateCandidateAdmission,
  rankResearchCandidates,
  resampleTradeSequence,
  splitResearchCandles,
} from "../lib/research-validation.ts";

const passing = {
  netReturnPct: 4.2,
  maxDrawdownPct: 7,
  profitFactor: 1.35,
  sampleSize: 32,
  liquidated: false,
};

test("keeps quick mode exploration-only even when metrics are positive", () => {
  const result = evaluateCandidateAdmission({
    mode: "quick",
    holdout: passing,
    walkForward: [passing, passing, { ...passing, netReturnPct: -1 }],
    stress: passing,
    maxDrawdownPct: 10,
    dataQuality: { isVerifiable: true },
  });
  assert.equal(result.qualified, false);
  assert.equal(result.validationLabel, "EXPLORATION_ONLY");
  assert.ok(result.reasons.some(reason => reason.includes("快速探索")));
});

test("requires positive untouched holdout, two thirds positive walks, trades, PF and risk gates", () => {
  const accepted = evaluateCandidateAdmission({
    mode: "standard",
    holdout: passing,
    walkForward: [passing, passing, { ...passing, netReturnPct: -1 }],
    stress: { ...passing, maxDrawdownPct: 9 },
    maxDrawdownPct: 10,
    dataQuality: { isVerifiable: true },
  });
  const rejected = evaluateCandidateAdmission({
    mode: "standard",
    holdout: { ...passing, netReturnPct: -0.1, profitFactor: 1.05, sampleSize: 19 },
    walkForward: [passing, { ...passing, netReturnPct: -1 }, { ...passing, netReturnPct: -2 }],
    stress: { ...passing, liquidated: true },
    maxDrawdownPct: 10,
    dataQuality: { isVerifiable: false },
  });
  assert.equal(accepted.qualified, true);
  assert.equal(accepted.validationLabel, "STANDARD_VERIFIED");
  assert.equal(rejected.qualified, false);
  assert.equal(rejected.validationLabel, "STANDARD_FAILED");
  assert.ok(rejected.reasons.length >= 6);
});

test("partitions in time order and never exposes final holdout twice", () => {
  const candles = Array.from({ length: 5_000 }, (_, index) => ({ openTime: index }));
  const split = splitResearchCandles("standard", candles);
  assert.equal(split.training.length, 3_000);
  assert.equal(split.validation.length, 1_000);
  assert.equal(split.holdout.length, 1_000);
  assert.ok(split.training.at(-1).openTime < split.validation[0].openTime);
  assert.ok(split.validation.at(-1).openTime < split.holdout[0].openTime);

  const guard = createHoldoutGuard();
  assert.equal(guard.claim("candidate-a").length, 0);
  assert.throws(() => guard.claim("candidate-a"), /只能运行一次/);
});

test("ranks qualified candidates first and returns at most three", () => {
  const ranked = rankResearchCandidates([
    { id: "failed-high", qualified: false, score: 99 },
    { id: "pass-low", qualified: true, score: 10 },
    { id: "pass-high", qualified: true, score: 20 },
    { id: "failed-low", qualified: false, score: 1 },
  ]);
  assert.deepEqual(ranked.map(item => item.id), ["pass-high", "pass-low", "failed-high"]);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2, 3]);
});

test("produces deterministic deep-mode trade-sequence resampling statistics", () => {
  const input = {
    trades: [{ netPnl: 120 }, { netPnl: -50 }, { netPnl: 80 }, { netPnl: -20 }],
    initialEquityUsdt: 10_000,
    iterations: 500,
    seed: 42,
  };
  const first = resampleTradeSequence(input);
  const second = resampleTradeSequence(input);

  assert.deepEqual(first, second);
  assert.equal(first.iterations, 500);
  assert.ok(first.probabilityPositive > 0.5);
  assert.ok(first.p95MaxDrawdownPct >= 0);
});
