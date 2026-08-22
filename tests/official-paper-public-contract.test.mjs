import assert from "node:assert/strict";
import test from "node:test";

import {
  officialPaperPortfolioDto,
  officialPaperTradeDto,
} from "../lib/official-paper-public-contract.ts";

test("official paper portfolio DTO exposes exact camelCase commercial values", () => {
  const dto = officialPaperPortfolioDto({
    id: "official-paper:m1:ai_conservative",
    membershipId: "m1",
    strategyCode: "ai_conservative",
    principalUsdt: "10000",
    cashUsdt: "9990.1",
    marketValueUsdt: "9.9",
    equityUsdt: "10000",
    realizedGrossPnlUsdt: "1.2",
    realizedNetPnlUsdt: "1.1",
    unrealizedPnlUsdt: "0",
    feesUsdt: "0.1",
    access: "active",
    openPositionCount: 1,
    positions: [{
      id: "position-1",
      symbol: "BTCUSDT",
      side: "long",
      quantity: "0.00018",
      averageEntryPrice: "55000",
      costBasisUsdt: "9.9",
      entryFeesUsdt: "0.01",
      lastMarkPrice: "55000",
      unrealizedPnlUsdt: "0",
      openedAt: "2026-08-20T00:00:00Z",
    }],
    updatedAt: "2026-08-20T00:00:01Z",
  });
  assert.equal(dto.initialCashUsdt, "10000.000000000000");
  assert.equal(dto.cashUsdt, "9990.100000000000");
  assert.equal(dto.marketValueUsdt, "9.900000000000");
  assert.equal(dto.status, "ACTIVE");
  assert.deepEqual(dto.runtime, {
    state: "NOT_STARTED", deploymentId: null, subscriptionId: null,
    mode: null, lastCycleSequence: 0, lastDecisionAt: null,
  });
  assert.equal(dto.positions[0].quantity, "0.000180000000");
  assert.equal(dto.positions[0].openedAt, "2026-08-20T00:00:00.000Z");
  assert.equal("principalUsdt" in dto, false);
  assert.equal("access" in dto, false);
});

test("official paper trade DTO carries the real runtime decision round", () => {
  const dto = officialPaperTradeDto({
    id: "fill-1",
    portfolioId: "official-paper:m1:ai_balanced",
    strategyCode: "ai_balanced",
    symbol: "ETHUSDT",
    action: "sell",
    quantity: "0.2",
    fillPrice: "3000",
    notionalUsdt: "600",
    feeUsdt: "0.6",
    allocatedEntryFeeUsdt: "0.5",
    realizedGrossPnlUsdt: "20",
    realizedNetPnlUsdt: "18.9",
    decisionRoundId: "cycle-7",
    traceId: "trace-7",
    filledAt: "2026-08-20T00:00:00Z",
  });
  assert.deepEqual(dto, {
    id: "fill-1",
    portfolioId: "official-paper:m1:ai_balanced",
    strategyCode: "ai_balanced",
    symbol: "ETHUSDT",
    side: "SELL",
    quantity: "0.200000000000",
    priceUsdt: "3000.000000000000",
    notionalUsdt: "600.000000000000",
    feeUsdt: "0.600000000000",
    allocatedEntryFeeUsdt: "0.500000000000",
    realizedGrossPnlUsdt: "20.000000000000",
    realizedNetPnlUsdt: "18.900000000000",
    decisionRoundId: "cycle-7",
    traceId: "trace-7",
    filledAt: "2026-08-20T00:00:00.000Z",
  });
});
