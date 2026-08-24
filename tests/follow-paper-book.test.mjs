import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOfficialPaperFill,
  createFollowPaperPortfolioState,
  createOfficialPaperPortfolioState,
  followPaperBookContract,
  officialPaperBookContract,
} from "../packages/domain/src/official-paper-portfolio.ts";

const contract = (overrides = {}) => followPaperBookContract({
  symbols: ["BTCUSDT", "ADAUSDT"],
  capitalPct: 3,
  maxTotalAllocationPct: 60,
  maxConcurrentAssets: 2,
  maxNewEntriesPerDay: 5,
  ...overrides,
});

const book = (overrides = {}) => createFollowPaperPortfolioState({
  contract: contract(), principalUsdt: 10_000, ...overrides,
});

test("官方卡的合同来自策略卡定义，与从前逐字一致", () => {
  // 泛化不得改变官方卡的行为——合同只是换了来源，值必须一样。
  const state = createOfficialPaperPortfolioState("ai_conservative");
  assert.deepEqual(state.contract, officialPaperBookContract("ai_conservative"));
  assert.ok(state.contract.symbols.includes("BTCUSDT"));
  assert.ok(state.contract.risk.maxAssetAllocationPct > 0);
});

test("社区跟单走同一套记账，只是合同不同", () => {
  // 另起一套并行记账会让两边的盈亏口径迟早分叉，而盈亏正是绩效分成的计算基础（INV-5）。
  const opened = applyOfficialPaperFill(book(), {
    action: "buy", symbol: "ADAUSDT", fillPrice: 0.5,
    quoteAmountUsdt: 300, feeRate: 0.001, filledAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(opened.positions.length, 1);
  assert.equal(opened.positions[0].symbol, "ADAUSDT");
  // 现金减去名义金额与手续费。
  assert.ok(opened.cashUsdt < 10_000);
  assert.ok(opened.feesUsdt > 0);

  const closed = applyOfficialPaperFill(opened, {
    action: "sell", symbol: "ADAUSDT", quantity: opened.positions[0].quantity,
    fillPrice: 0.6, feeRate: 0.001, filledAt: "2026-08-25T00:00:00.000Z",
  });
  assert.equal(closed.positions.length, 0);
  assert.ok(closed.realizedNetPnlUsdt > 0, "涨了应当有正的已实现净盈亏");
  // 净盈亏必须小于毛盈亏——手续费是真实成本，记少了会让分成多收。
  assert.ok(closed.realizedNetPnlUsdt < closed.realizedGrossPnlUsdt);
});

test("合同外的品种买不进来", () => {
  // 客户同意的是这个策略在这些品种上交易。买进合同外的品种，等于策略跑到了客户没同意的
  // 范围里。
  assert.throws(
    () => applyOfficialPaperFill(book(), {
      action: "buy", symbol: "ETHUSDT", fillPrice: 3_000,
      quoteAmountUsdt: 300, feeRate: 0.001, filledAt: "2026-08-24T00:00:00.000Z",
    }),
    /仅支持其合同内的现货品种/,
  );
});

test("每单占比用客户同意的那个数字", () => {
  // capitalPct=3 → 本金 10,000 的 3% = 300 USDT 上限。
  const tight = createFollowPaperPortfolioState({
    contract: contract({ capitalPct: 3 }), principalUsdt: 10_000,
  });
  assert.throws(
    () => applyOfficialPaperFill(tight, {
      action: "buy", symbol: "BTCUSDT", fillPrice: 60_000,
      quoteAmountUsdt: 301, feeRate: 0.001, filledAt: "2026-08-24T00:00:00.000Z",
    }),
    /上限/,
  );
  // 同样一笔在 capitalPct=10 的合同下可以。
  const loose = createFollowPaperPortfolioState({
    contract: contract({ capitalPct: 10 }), principalUsdt: 10_000,
  });
  const filled = applyOfficialPaperFill(loose, {
    action: "buy", symbol: "BTCUSDT", fillPrice: 60_000,
    quoteAmountUsdt: 301, feeRate: 0.001, filledAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(filled.positions.length, 1);
});

test("域层不编平台护栏的默认值", () => {
  // 总仓位、并发资产、每日开仓这三项是平台侧的操作护栏，不是客户同意过的条款。
  // 藏进域层默认值会让「客户到底同意了什么」变得说不清。
  for (const missing of ["maxTotalAllocationPct", "maxConcurrentAssets", "maxNewEntriesPerDay"]) {
    assert.throws(() => contract({ [missing]: 0 }), /无效/, `${missing} 缺失时必须报错`);
    assert.throws(() => contract({ [missing]: Number.NaN }), /无效/);
  }
  assert.throws(() => contract({ symbols: [] }), /至少包含一个现货品种/);
  assert.throws(() => contract({ capitalPct: 0 }), /每单占比无效/);
  assert.throws(() => contract({ capitalPct: 101 }), /每单占比无效/);
});

test("社区跟单组合没有官方卡代号", () => {
  // 放一个官方卡代号只是为了满足类型，会让下游误判这是一张官方卡。
  assert.equal(book().strategyCode, null);
  assert.equal(createOfficialPaperPortfolioState("ai_balanced").strategyCode, "ai_balanced");
});
