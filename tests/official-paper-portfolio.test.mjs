import assert from "node:assert/strict";
import test from "node:test";

import { officialTradingHallStrategies } from "../packages/contracts/src/trading-hall.ts";
import {
  applyOfficialPaperFill,
  createOfficialPaperPortfolioState,
  markOfficialPaperPortfolio,
  officialPaperPortfolioSeeds,
} from "../packages/domain/src/official-paper-portfolio.ts";

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
  assert.equal(bought.positions[0].entryFeesUsdt, 1);

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
  assert.equal(sold.realizedGrossPnlUsdt, 100);
  assert.equal(sold.realizedNetPnlUsdt, 97.9);
  assert.equal(sold.realizedPnlUsdt, 97.9);
  assert.equal(sold.feesUsdt, 2.1);
  assert.equal(sold.positions.length, 0);
  assert.equal(sold.equityUsdt, 10_097.9);
});

test("partial and final sells allocate entry fees exactly once without leakage", () => {
  const bought = applyOfficialPaperFill(createOfficialPaperPortfolioState("ai_balanced"), {
    action: "buy", symbol: "BTCUSDT", fillPrice: 50_000, quoteAmountUsdt: 1_000,
    feeRate: 0.001, filledAt: "2026-08-20T01:00:00.000Z",
  });
  const partial = applyOfficialPaperFill(bought, {
    action: "sell", symbol: "BTCUSDT", fillPrice: 55_000, quantity: 0.01,
    feeRate: 0.001, filledAt: "2026-08-20T02:00:00.000Z",
  });
  assert.equal(partial.positions[0].entryFeesUsdt, 0.5);
  assert.equal(partial.realizedGrossPnlUsdt, 50);
  assert.equal(partial.realizedNetPnlUsdt, 48.95);
  assert.deepEqual(partial.fills.at(-1), {
    action: "sell", symbol: "BTCUSDT", quantity: 0.01, fillPrice: 55_000,
    notionalUsdt: 550, feeUsdt: 0.55, allocatedEntryFeeUsdt: 0.5,
    realizedGrossPnlUsdt: 50, realizedNetPnlUsdt: 48.95,
    filledAt: "2026-08-20T02:00:00.000Z",
  });

  const closed = applyOfficialPaperFill(partial, {
    action: "sell", symbol: "BTCUSDT", fillPrice: 60_000, quantity: 0.01,
    feeRate: 0.001, filledAt: "2026-08-20T03:00:00.000Z",
  });
  assert.equal(closed.positions.length, 0);
  assert.equal(closed.realizedGrossPnlUsdt, 150);
  assert.equal(closed.realizedNetPnlUsdt, 147.85);
  assert.equal(closed.feesUsdt, 2.15);
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

// —— 本金放宽之后的回归 ——
//
// 配置上限此前按常量 10000 计算，与组合自己的本金无关。模拟盘恒为 10000 时
// 两者恰好相等，所以这个 bug 在模拟盘上永远看不出来；实盘一接上就会静默放大风控上限。

test("配置上限按组合自己的本金算，不是按 10000 常量", () => {
  const base = createOfficialPaperPortfolioState("ai_conservative");
  const definition = officialTradingHallStrategies.find((item) => item.code === "ai_conservative");
  const symbol = definition.symbols[0];
  const cap = definition.risk.maxAssetAllocationPct / 100;

  // 一个 3000 USDT 的实盘组合。按常量算，它能买到 10000 * cap；按本金算只能买 3000 * cap。
  const live = { ...base, principalUsdt: 3_000, cashUsdt: 3_000, equityUsdt: 3_000 };
  const overLimit = 3_000 * cap + 1;
  assert.throws(
    () => applyOfficialPaperFill(live, {
      action: "buy", symbol, fillPrice: 100, quoteAmountUsdt: overLimit,
      feeRate: 0.001, filledAt: new Date().toISOString(),
    }),
    /单资产配置上限/,
    "按 10000 算的话这笔会被放行，等于风控上限静默放大 3 倍",
  );

  const withinLimit = applyOfficialPaperFill(live, {
    action: "buy", symbol, fillPrice: 100, quoteAmountUsdt: 3_000 * cap - 1,
    feeRate: 0.001, filledAt: new Date().toISOString(),
  });
  assert.equal(withinLimit.principalUsdt, 3_000, "记账不得把实盘本金重新盖成 10000");
});

test("模拟盘的行为不因放宽而改变", () => {
  const state = createOfficialPaperPortfolioState("ai_conservative");
  assert.equal(state.principalUsdt, 10_000);
  const definition = officialTradingHallStrategies.find((item) => item.code === "ai_conservative");
  const symbol = definition.symbols[0];
  const cap = definition.risk.maxAssetAllocationPct / 100;
  assert.throws(() => applyOfficialPaperFill(state, {
    action: "buy", symbol, fillPrice: 100, quoteAmountUsdt: 10_000 * cap + 1,
    feeRate: 0.001, filledAt: new Date().toISOString(),
  }), /单资产配置上限/);
  const ok = applyOfficialPaperFill(state, {
    action: "buy", symbol, fillPrice: 100, quoteAmountUsdt: 10_000 * cap - 1,
    feeRate: 0.001, filledAt: new Date().toISOString(),
  });
  assert.equal(ok.principalUsdt, 10_000);
});
