import assert from "node:assert/strict";
import test from "node:test";

import { officialTradingHallStrategies } from "../packages/contracts/src/trading-hall.ts";
import {
  applyOfficialPaperFill,
  createOfficialPaperPortfolioState,
  markOfficialPaperPortfolio,
  officialPaperPortfolioSeeds,
} from "../lib/official-paper-portfolio.ts";

test("every membership receives one isolated immutable 10,000 USDT portfolio per official card", () => {
  const seeds = officialPaperPortfolioSeeds({ membershipId: "membership-a", customerId: "customer-a" });
  assert.equal(seeds.length, 3);
  assert.deepEqual(seeds.map((seed) => seed.strategyCode), officialTradingHallStrategies.map((item) => item.code));
  assert.equal(new Set(seeds.map((seed) => seed.id)).size, 3);
  for (const seed of seeds) {
    assert.equal(seed.principalUsdt, 10_000);
    assert.equal(seed.cashUsdt, 10_000);
    assert.equal(seed.customerExchangeAccountId, null);
  }
});

test("paper fills keep principal immutable and calculate cash, fees, realized and unrealized PnL server-side", () => {
  const initial = createOfficialPaperPortfolioState("ai_balanced");
  const bought = applyOfficialPaperFill(initial, {
    action: "buy",
    symbol: "BTCUSDT",
    fillPrice: 50_000,
    quoteAmountUsdt: 1_000,
    feeRate: 0.001,
    filledAt: "2026-08-20T01:00:00.000Z",
  });
  assert.equal(bought.principalUsdt, 10_000);
  assert.equal(bought.cashUsdt, 8_999);
  assert.equal(bought.feesUsdt, 1);
  assert.equal(bought.positions[0].side, "long");
  assert.equal(bought.positions[0].quantity, 0.02);

  const marked = markOfficialPaperPortfolio(bought, { BTCUSDT: 55_000 });
  assert.equal(marked.unrealizedPnlUsdt, 100);
  assert.equal(marked.equityUsdt, 10_099);

  const sold = applyOfficialPaperFill(marked, {
    action: "sell",
    symbol: "BTCUSDT",
    fillPrice: 55_000,
    quantity: 0.02,
    feeRate: 0.001,
    filledAt: "2026-08-20T02:00:00.000Z",
  });
  assert.equal(sold.principalUsdt, 10_000);
  assert.equal(sold.cashUsdt, 10_097.9);
  assert.equal(sold.realizedPnlUsdt, 100);
  assert.equal(sold.feesUsdt, 2.1);
  assert.equal(sold.positions.length, 0);
  assert.equal(sold.equityUsdt, 10_097.9);
});

test("official paper portfolios reject short, derivatives, over-allocation and expired new entries", () => {
  const state = createOfficialPaperPortfolioState("ai_conservative");
  assert.throws(() => applyOfficialPaperFill(state, {
    action: "buy", symbol: "DOGEUSDT", fillPrice: 1, quoteAmountUsdt: 100, feeRate: 0.001,
    filledAt: "2026-08-20T01:00:00.000Z",
  }), /BTC|ETH|SOL|现货/);
  assert.throws(() => applyOfficialPaperFill(state, {
    action: "short", symbol: "BTCUSDT", fillPrice: 50_000, quoteAmountUsdt: 100, feeRate: 0.001,
    filledAt: "2026-08-20T01:00:00.000Z",
  }), /多头现货/);
  assert.throws(() => applyOfficialPaperFill(state, {
    action: "buy", symbol: "BTCUSDT", fillPrice: 50_000, quoteAmountUsdt: 1_501, feeRate: 0.001,
    filledAt: "2026-08-20T01:00:00.000Z",
  }), /单资产/);
  assert.throws(() => applyOfficialPaperFill({ ...state, access: "close_only" }, {
    action: "buy", symbol: "BTCUSDT", fillPrice: 50_000, quoteAmountUsdt: 100, feeRate: 0.001,
    filledAt: "2026-08-20T01:00:00.000Z",
  }), /只允许平仓/);
});
