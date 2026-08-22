import assert from "node:assert/strict";
import test from "node:test";

import { createLiveExecutionPort } from "../lib/execution/server/live-execution-port.ts";
import { createRateLimitPool } from "../lib/execution/server/rate-limit-pool.ts";

// 全部用假适配器：这段编排（幂等 id、限流、成交分类、失败隔离）不需要网络，
// 也不需要任何真实凭证就能完整验证。

function makeIntent(overrides = {}) {
  return {
    id: "intent-1",
    provenance: { decisionRoundId: "round-1", traceId: "t", contractHash: "c", candleId: "k", strategyCode: "trend-v1" },
    symbol: "BTC/USDT",
    side: "buy",
    targetPositionRatio: 0.5,
    entryPriceRange: { min: 100, max: 100 },
    stopLossPrice: 90,
    takeProfitPrice: 120,
    validUntil: "2099-01-01T00:00:00.000Z",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    intent: makeIntent(overrides.intent),
    portfolioId: overrides.portfolioId ?? "pf-1",
    availableCapital: overrides.availableCapital ?? 1000,
    capitalCapRatio: overrides.capitalCapRatio ?? 1,
  };
}

function makeDeps(overrides = {}) {
  const placed = [];
  const enqueued = [];
  const adapter = {
    exchange: "okx",
    async placeMarketOrder(input) {
      placed.push(input);
      // 假适配器按真实语义返回：买入用计价金额换算出基础币成交量，卖出直接用数量。
      // 从前这里写 `filledQuantity: input.quantity`，恰好把单位错配抹平了——
      // 那正是 A1 那个 bug 能躲过测试的原因。
      const filled = input.size.side === "buy" ? input.size.quoteAmount / 100 : input.size.baseQuantity;
      return overrides.orderResult ?? {
        externalOrderId: "ex-1", state: "filled",
        filledQuantity: filled, averagePrice: 100, feeAmount: 0.5,
      };
    },
    async getOrderByClientOrderId() { return overrides.recovered ?? null; },
    ...overrides.adapter,
  };
  return {
    placed,
    enqueued,
    adapter,
    deps: {
      async resolveAccount(portfolioId) {
        if (overrides.noAccount) return null;
        return { accountId: `acct-${portfolioId}`, customerId: "cust-1", exchange: "okx", environment: "live" };
      },
      async loadCredential() { return { credentials: { apiKey: "k", secretKey: "s" } }; },
      adapterFor: (exchange) => (exchange === "okx" ? adapter : null),
      rateLimiter: { async acquire() { return 0; } },
      async loadReconciliationState() {
        return overrides.reconciliationState ?? { hasEscalated: false, pendingSymbols: [] };
      },
      async enqueueReconciliation(input) { enqueued.push(input); },
      async loadActiveKillSwitches() { return overrides.killSwitches ?? []; },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      executionProduct: overrides.product ?? "spot_usdt",
      async loadLiveRoutingGrants() {
        if (overrides.grants) return overrides.grants;
        return (overrides.enabled ?? true) ? [{ exchange: "okx", environment: "live" }] : [];
      },
      ...overrides.deps,
    },
  };
}

test("没有授权时不路由，且留下明确回执而不是静默跳过", async () => {
  const { deps, placed } = makeDeps({ enabled: false });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.rejectionReason, "LIVE_ROUTING_NOT_GRANTED");
  assert.equal(placed.length, 0, "未授权时不得向交易所发出任何请求");
});

test("永续在任何授权下都不路由", async () => {
  // AGENTS.md：真实永续订单路由必须保持关闭。它不是一个可配置项。
  const { deps, placed } = makeDeps({
    product: "usdt_perpetual",
    grants: [{ exchange: "okx", environment: "live" }],
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "PERPETUAL_ROUTING_FORBIDDEN");
  assert.equal(placed.length, 0);
});

test("开通 demo 不等于开通实盘", async () => {
  const { deps, placed } = makeDeps({ grants: [{ exchange: "okx", environment: "demo" }] });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "LIVE_ROUTING_NOT_GRANTED");
  assert.equal(placed.length, 0);
});

test("授权另一家交易所不会打开 OKX", async () => {
  const { deps, placed } = makeDeps({ grants: [{ exchange: "binance", environment: "live" }] });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "LIVE_ROUTING_NOT_GRANTED");
  assert.equal(placed.length, 0);
});

test("同一轮同一组合的重试落在同一个 clientOrderId 上", async () => {
  const { deps, placed } = makeDeps();
  const port = createLiveExecutionPort(deps);
  await port.execute([makeRequest()]);
  await port.execute([makeRequest()]);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].clientOrderId, placed[1].clientOrderId,
    "重试必须复用同一个 id，交易所才能替我们判重");
});

test("同一轮同一组合的买卖是不同的 clientOrderId", async () => {
  // 共用一个的话，平仓会被交易所当成开仓的重复请求拒掉——客户想离场却离不了。
  const { deps, placed } = makeDeps();
  const port = createLiveExecutionPort(deps);
  await port.execute([makeRequest()]);
  await port.execute([makeRequest({
    intent: { side: "sell", entryPriceRange: { min: 100, max: 100 }, stopLossPrice: 110, takeProfitPrice: 80 },
  })]);
  assert.notEqual(placed[0].clientOrderId, placed[1].clientOrderId);
});

test("部分成交如实记成 partial", async () => {
  const { deps } = makeDeps({
    orderResult: { externalOrderId: "ex-1", state: "partially_filled", filledQuantity: 3, averagePrice: 100, feeAmount: 0.1 },
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.outcome, "partial");
  assert.equal(receipt.filledQuantity, 3);
  assert.equal(receipt.averagePrice, 100);
});

test("下单超时后用 clientOrderId 查回真实结果", async () => {
  // 这是确定性 clientOrderId 的核心价值：把「不知道下没下」变成可自动恢复。
  let queried = null;
  const { deps } = makeDeps({
    adapter: {
      async placeMarketOrder() { throw new Error("timeout"); },
      async getOrderByClientOrderId(input) {
        queried = input.clientOrderId;
        return { externalOrderId: "ex-9", state: "filled", filledQuantity: 5, averagePrice: 100, feeAmount: 0.2 };
      },
    },
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.outcome, "filled");
  assert.equal(receipt.externalOrderId, "ex-9");
  assert.ok(queried?.startsWith("RV"));
});

test("下单失败且查不到，判为未下单而不是状态未知", async () => {
  const { deps } = makeDeps({
    adapter: {
      async placeMarketOrder() { throw new Error("rejected"); },
      async getOrderByClientOrderId() { return null; },
    },
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.match(receipt.rejectionReason, /^PLACE_FAILED/);
});

test("下单失败且查单也失败，必须进 reconcile_wait 而不是当作没下单", async () => {
  // 当作没下单会让重试重复下单——这是最危险的方向（INV-7）。
  const { deps } = makeDeps({
    adapter: {
      async placeMarketOrder() { throw new Error("timeout"); },
      async getOrderByClientOrderId() { throw new Error("exchange down"); },
    },
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "RECONCILE_WAIT");
});

test("单个账户失败不影响同一轮的其他账户", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    adapter: {
      async placeMarketOrder(input) {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        const filled = input.size.side === "buy" ? input.size.quoteAmount / 100 : input.size.baseQuantity;
        return { externalOrderId: `ex-${calls}`, state: "filled", filledQuantity: filled, averagePrice: 100, feeAmount: 0 };
      },
      async getOrderByClientOrderId() { return null; },
    },
  });
  const receipts = await createLiveExecutionPort(deps).execute([
    makeRequest({ portfolioId: "pf-1" }),
    makeRequest({ portfolioId: "pf-2" }),
    makeRequest({ portfolioId: "pf-3" }),
  ]);
  assert.equal(receipts.length, 3, "每条请求都必须有回执，一条都不能少");
  assert.equal(receipts[0].outcome, "filled");
  assert.match(receipts[1].rejectionReason, /^PLACE_FAILED/);
  assert.equal(receipts[2].outcome, "filled");
});

test("找不到组合账户或适配器时给出可区分的拒绝原因", async () => {
  const missingAccount = makeDeps({ noAccount: true });
  const [a] = await createLiveExecutionPort(missingAccount.deps).execute([makeRequest()]);
  assert.equal(a.rejectionReason, "PORTFOLIO_ACCOUNT_NOT_FOUND");

  const noAdapter = makeDeps({ deps: { adapterFor: () => null } });
  const [b] = await createLiveExecutionPort(noAdapter.deps).execute([makeRequest()]);
  assert.equal(b.rejectionReason, "EXCHANGE_ADAPTER_NOT_AVAILABLE");
});

test("客户设定的资金上限压过策略意图", async () => {
  const { deps, placed } = makeDeps();
  await createLiveExecutionPort(deps).execute([
    makeRequest({ availableCapital: 1000, capitalCapRatio: 0.1 }),
  ]);
  // 意图想要 50%，客户上限 10%——取更严格的：1000 * 0.1 = 100 USDT。
  // 买单必须以**计价金额**下达，而不是 100/价格 得到的基础币数量。
  assert.deepEqual(placed[0].size, { side: "buy", quoteAmount: 100 });
});

// --- 限流池 ---------------------------------------------------------------

test("限流池按计划排队，并发调用不会各自基于旧状态放行", async () => {
  let clock = 0;
  const slept = [];
  const pool = createRateLimitPool({
    limits: { okx: { account: { capacity: 1, refillPerSecond: 1 }, global: { capacity: 100, refillPerSecond: 100 } } },
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  await pool.acquire({ exchange: "okx", accountId: "a" });
  await pool.acquire({ exchange: "okx", accountId: "a" });
  await pool.acquire({ exchange: "okx", accountId: "a" });
  assert.deepEqual(slept, [1000, 1000], "第 2、3 笔各等 1 秒");
});

test("不同账户各有自己的账户级预算", async () => {
  let clock = 0;
  const slept = [];
  const pool = createRateLimitPool({
    limits: { okx: { account: { capacity: 1, refillPerSecond: 1 }, global: { capacity: 100, refillPerSecond: 100 } } },
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  await pool.acquire({ exchange: "okx", accountId: "a" });
  await pool.acquire({ exchange: "okx", accountId: "b" });
  assert.deepEqual(slept, [], "两个不同账户都应立即放行");
});

test("未知交易所走最保守的一档，而不是不限流", async () => {
  let clock = 0;
  const slept = [];
  const pool = createRateLimitPool({
    limits: {}, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  await pool.acquire({ exchange: "unknown-exchange", accountId: "a" });
  await pool.acquire({ exchange: "unknown-exchange", accountId: "a" });
  await pool.acquire({ exchange: "unknown-exchange", accountId: "a" });
  assert.ok(slept.length >= 1, "第 3 笔必须被限住");
});

// --- 对账未决时的开仓准入 -------------------------------------------------

test("对账升级人工后挡住开仓", async () => {
  const { deps, placed } = makeDeps({ reconciliationState: { hasEscalated: true, pendingSymbols: [] } });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "RECONCILIATION_ESCALATED");
  assert.equal(placed.length, 0);
});

test("同品种待对账时挡住该品种开仓，其它品种不受影响", async () => {
  const blocked = makeDeps({ reconciliationState: { hasEscalated: false, pendingSymbols: ["BTC/USDT"] } });
  const [a] = await createLiveExecutionPort(blocked.deps).execute([makeRequest()]);
  assert.equal(a.rejectionReason, "RECONCILIATION_PENDING_FOR_SYMBOL");

  const other = makeDeps({ reconciliationState: { hasEscalated: false, pendingSymbols: ["ETH/USDT"] } });
  const [b] = await createLiveExecutionPort(other.deps).execute([makeRequest()]);
  assert.equal(b.outcome, "filled");
});

test("平仓永远放行——哪怕该账户已升级人工", async () => {
  // 退出能力不依赖任何一层在线。把平仓也挡住，等于客户在最需要离场的时候离不了，
  // 而对账未决往往正是行情剧烈波动的时候。
  const { deps, placed } = makeDeps({ reconciliationState: { hasEscalated: true, pendingSymbols: ["BTC/USDT"] } });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest({
    intent: { side: "sell", entryPriceRange: { min: 100, max: 100 }, stopLossPrice: 110, takeProfitPrice: 80 },
  })]);
  assert.equal(receipt.outcome, "filled");
  assert.equal(placed.length, 1, "平仓必须真的发出去");
});

test("下单成功也要登记待对账——下单响应不是事实", async () => {
  const { deps, enqueued } = makeDeps();
  await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].symbol, "BTC/USDT");
  assert.equal(enqueued[0].requestedQuantity, 5);
});

test("RECONCILE_WAIT 必须真的登记，而不只是回执上的一句话", async () => {
  // 只出现在回执文字里的 RECONCILE_WAIT 没人会去查，等于没有。
  const { deps, enqueued } = makeDeps({
    adapter: {
      async placeMarketOrder() { throw new Error("timeout"); },
      async getOrderByClientOrderId() { throw new Error("exchange down"); },
    },
  });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "RECONCILE_WAIT");
  assert.equal(enqueued.length, 1, "必须留下一条待对账记录");
  assert.equal(enqueued[0].externalOrderId, null);
});

test("确认下单未发生时不登记对账", async () => {
  const { deps, enqueued } = makeDeps({
    adapter: {
      async placeMarketOrder() { throw new Error("rejected"); },
      async getOrderByClientOrderId() { return null; },
    },
  });
  await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(enqueued.length, 0, "交易所明确说没这单，没有什么可对的");
});

// --- 下单量的单位 -----------------------------------------------------------

test("买单以计价金额下达，卖单以基础币数量下达", async () => {
  // 这是资金安全评审抓到的最严重缺陷（A1）：编排层算出的是基础币数量，
  // 而两个交易所适配器买入时都当成计价金额用。价格 >1 时表现为买得太少，
  // 价格 <1 时是**成倍超买**——价 0.20 的币要买 1000 USDT，实际会下 5000 USDT。
  const buy = makeDeps();
  await createLiveExecutionPort(buy.deps).execute([makeRequest({ availableCapital: 1000, capitalCapRatio: 0.2 })]);
  assert.deepEqual(buy.placed[0].size, { side: "buy", quoteAmount: 200 },
    "买单必须是 1000×0.2=200 USDT，不是 200/价格 得到的基础币数量");

  const sell = makeDeps();
  await createLiveExecutionPort(sell.deps).execute([makeRequest({
    availableCapital: 1000, capitalCapRatio: 0.2,
    intent: { side: "sell", entryPriceRange: { min: 100, max: 100 }, stopLossPrice: 110, takeProfitPrice: 80 },
  })]);
  assert.deepEqual(sell.placed[0].size, { side: "sell", baseQuantity: 2 },
    "卖单必须是 200/100=2 个基础币");
});

test("买单金额与品种价格无关——低价品种不会被放大", async () => {
  // 单位错配的危险正在于它随价格缩放：价 0.20 时，错误实现会把 500 USDT 的意图
  // 变成 2500 USDT 的买单（500/0.2）。正确实现下，两个差 500 倍的价格必须得到
  // 完全相同的买单金额。
  async function quoteAmountAtPrice(price) {
    const { deps, placed } = makeDeps();
    await createLiveExecutionPort(deps).execute([makeRequest({
      availableCapital: 1000,
      intent: { entryPriceRange: { min: price, max: price }, stopLossPrice: price / 2, takeProfitPrice: price * 2 },
    })]);
    return placed[0].size.quoteAmount;
  }
  const cheap = await quoteAmountAtPrice(0.2);
  const expensive = await quoteAmountAtPrice(100);
  assert.equal(cheap, expensive, "买单金额不得随价格变化");
  assert.equal(cheap, 500, "1000 资金 × 意图比例 0.5 = 500 USDT");
});

test("撤销实盘路由授权不得挡住卖单", async () => {
  // live-routing.ts 开头写着「平仓永不受限」，但 resolveLiveRouting 曾经根本没有
  // side 参数——运维一按关停，所有客户的卖单也被拒，正是熔断本该保护他们免于
  // 遭遇的处境：事故中离不了场（INV-7）。
  const { deps, placed } = makeDeps({ grants: [] });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest({
    intent: { side: "sell", entryPriceRange: { min: 100, max: 100 }, stopLossPrice: 110, takeProfitPrice: 80 },
  })]);
  assert.equal(receipt.outcome, "filled", "无授权时卖单仍须发出");
  assert.equal(placed.length, 1);
});

test("买单在无授权时仍然被挡住", async () => {
  const { deps, placed } = makeDeps({ grants: [] });
  const [receipt] = await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.equal(receipt.rejectionReason, "LIVE_ROUTING_NOT_GRANTED");
  assert.equal(placed.length, 0);
});

test("适配器按 (交易所, 环境) 选择，demo 账户不会走到实盘适配器", async () => {
  // environment 曾经断在 adapterFor 这一行：打开实盘的那天，绑定为 demo 的账户
  // 会跟着一起上真实交易所，「demo 与 live 分别授权」那道闸门反向失效。
  const seen = [];
  const { deps } = makeDeps({
    deps: {
      async resolveAccount(portfolioId) {
        return { accountId: `acct-${portfolioId}`, customerId: "cust-1", exchange: "okx", environment: "demo" };
      },
      adapterFor: (exchange, environment) => { seen.push([exchange, environment]); return null; },
    },
  });
  await createLiveExecutionPort(deps).execute([makeRequest()]);
  assert.deepEqual(seen, [["okx", "demo"]], "适配器选择必须收到账户的 environment");
});
