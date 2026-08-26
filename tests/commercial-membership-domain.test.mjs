import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateTokenCost,
  calculateWeeklyPerformanceFee,
  requiredLegalDocumentTypes,
} from "../packages/domain/src/commercial-membership-domain.ts";

test("token cost is versioned, integer and rounded up", () => {
  assert.deepEqual(calculateTokenCost({
    modelVersion: "token-cost-v1",
    usageReliable: true,
    rateReliable: true,
    inputTokens: 1_000_001,
    outputTokens: 500_000,
  }), { modelVersion: "token-cost-v1", credits: "26" });
});

test("token cost refuses missing or unreliable usage", () => {
  assert.throws(() => calculateTokenCost({
    modelVersion: "token-cost-v1",
    usageReliable: false,
    rateReliable: true,
    inputTokens: 1,
    outputTokens: 1,
  }), /AI_USAGE_NOT_RELIABLE/);
  assert.throws(() => calculateTokenCost({
    modelVersion: "unknown",
    usageReliable: true,
    rateReliable: true,
    inputTokens: 1,
    outputTokens: 1,
  }), /AI_COST_MODEL_UNSUPPORTED/);
  assert.throws(() => calculateTokenCost({
    modelVersion: "token-cost-v1",
    usageReliable: true,
    rateReliable: false,
    inputTokens: 1,
    outputTokens: 1,
  }), /AI_RATE_NOT_RELIABLE/);
});

test("weekly fee applies HWM and loss carry using cumulative closed paper pnl", () => {
  assert.deepEqual(calculateWeeklyPerformanceFee({
    weekNetPnl: "300",
    cumulativeNetPnl: "1300",
    committedHighWaterMark: "1000",
    feeBps: 2000,
  }), {
    weekNetPnl: "300",
    cumulativeNetPnl: "1300",
    committedHighWaterMark: "1000",
    eligibleProfit: "300",
    lossCarry: "0",
    feeAmount: "60",
  });
  assert.equal(calculateWeeklyPerformanceFee({
    weekNetPnl: "-200",
    cumulativeNetPnl: "800",
    committedHighWaterMark: "1000",
    feeBps: 2000,
  }).feeAmount, "0");
});

test("membership order legal gate requires every active legal type", () => {
  assert.deepEqual(requiredLegalDocumentTypes, ["service_entity","jurisdiction","privacy","terms","risk_disclosure","simulated_performance_fee_opinion","refund_policy"]);
});
