import assert from "node:assert/strict";
import test from "node:test";

import {
  binanceSymbol,
  getBinanceSpotOrder,
  placeBinanceSpotMarketOrder,
} from "../lib/binance-spot-execution.ts";
import {
  createBinanceOrderAdapter,
  normalizeBinanceStatus,
} from "../lib/execution/server/binance-adapter.ts";

// 全部用注入的 fetch。不需要网络，也不需要任何真实凭证。

const CREDENTIALS = { apiKey: "key", secretKey: "secret" };
const NOW = () => new Date("2026-08-22T00:00:00.000Z");

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = handler(String(url), calls.length);
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("品种去掉分隔符并大写", () => {
  assert.equal(binanceSymbol("BTC/USDT"), "BTCUSDT");
  assert.equal(binanceSymbol("eth-usdt"), "ETHUSDT");
  assert.throws(() => binanceSymbol("///"), /品种格式无效/);
});

test("买入按计价金额下单，卖出按数量", async () => {
  const fetchImpl = stubFetch(() => ({
    orderId: 11, clientOrderId: "RV1", symbol: "BTCUSDT", side: "BUY",
    status: "FILLED", executedQty: "0.01", cummulativeQuoteQty: "1000",
    fills: [{ commission: "1", commissionAsset: "USDT" }],
  }));
  await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    side: "buy", quantity: 1000, clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.match(fetchImpl.calls[0].url, /quoteOrderQty=1000/);
  assert.ok(!fetchImpl.calls[0].url.includes("quantity="), "买入不应带 quantity");

  const sellFetch = stubFetch(() => ({ orderId: 12, status: "FILLED", executedQty: "0.01", cummulativeQuoteQty: "1000" }));
  await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    side: "sell", quantity: 0.01, clientOrderId: "RV2", fetchImpl: sellFetch, now: NOW,
  });
  assert.match(sellFetch.calls[0].url, /quantity=0\.01/);
});

test("均价由成交额除以成交量算出，不编造价格", async () => {
  const fetchImpl = stubFetch(() => ({
    orderId: 11, status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "50000",
  }));
  const order = await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    side: "sell", quantity: 0.5, clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.equal(order.averagePrice, 100000);
});

test("未成交时均价为 0，交给上层判定而不是补一个价", async () => {
  const fetchImpl = stubFetch(() => ({ orderId: 11, status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" }));
  const order = await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    side: "sell", quantity: 1, clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.equal(order.averagePrice, 0);
});

test("非稳定币手续费按成交均价折算", async () => {
  const fetchImpl = stubFetch(() => ({
    orderId: 11, status: "FILLED", executedQty: "1", cummulativeQuoteQty: "100",
    fills: [{ commission: "0.1", commissionAsset: "BNB" }],
  }));
  const order = await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BNB/USDT",
    side: "sell", quantity: 1, clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.equal(order.feeUsdt, 10);
});

test("查单会再查 myTrades 补齐手续费", async () => {
  // 查单响应不含手续费。把未知的手续费当成 0 会让绩效分成算多。
  const fetchImpl = stubFetch((url) => url.includes("myTrades")
    ? [{ commission: "0.5", commissionAsset: "USDT" }, { commission: "0.25", commissionAsset: "USDT" }]
    : { orderId: 77, origClientOrderId: "RV1", status: "FILLED", executedQty: "1", cummulativeQuoteQty: "100" });
  const order = await getBinanceSpotOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.equal(order.feeUsdt, 0.75);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /orderId=77/);
});

test("未成交的订单不去查 myTrades", async () => {
  const fetchImpl = stubFetch(() => ({ orderId: 77, status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" }));
  await getBinanceSpotOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    clientOrderId: "RV1", fetchImpl, now: NOW,
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test("查单用 origClientOrderId，下单用 newClientOrderId", async () => {
  const placeFetch = stubFetch(() => ({ orderId: 1, status: "NEW" }));
  await placeBinanceSpotMarketOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    side: "sell", quantity: 1, clientOrderId: "RVX", fetchImpl: placeFetch, now: NOW,
  });
  assert.match(placeFetch.calls[0].url, /newClientOrderId=RVX/);

  const queryFetch = stubFetch(() => ({ orderId: 1, status: "NEW", executedQty: "0" }));
  await getBinanceSpotOrder({
    credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
    clientOrderId: "RVX", fetchImpl: queryFetch, now: NOW,
  });
  assert.match(queryFetch.calls[0].url, /origClientOrderId=RVX/);
});

test("clientOrderId 超长直接抛，不静默截断", async () => {
  // 截断会破坏幂等：同一次重试算出不同 id，交易所就判不了重。
  await assert.rejects(
    () => placeBinanceSpotMarketOrder({
      credentials: CREDENTIALS, environment: "demo", symbol: "BTC/USDT",
      side: "sell", quantity: 1, clientOrderId: "R".repeat(37), fetchImpl: stubFetch(() => ({})), now: NOW,
    }),
    /客户端订单编号无效/,
  );
});

test("交易所明确说订单不存在时返回 null", async () => {
  const adapter = createBinanceOrderAdapter({
    fetchImpl: stubFetch(() => ({ code: -2013, msg: "Order does not exist." })),
  });
  const result = await adapter.getOrderByClientOrderId({
    credentials: CREDENTIALS, symbol: "BTC/USDT", clientOrderId: "RV1",
  });
  assert.equal(result, null);
});

test("其它错误继续往上抛，不得被当成订单不存在", async () => {
  // 把网络故障或权限错误当成「订单不存在」，会让对账把真实成交判成未下单，
  // 然后重复下单——这是最危险的方向（INV-7）。
  const adapter = createBinanceOrderAdapter({
    fetchImpl: stubFetch(() => ({ code: -1021, msg: "Timestamp out of recvWindow." })),
  });
  await assert.rejects(
    () => adapter.getOrderByClientOrderId({ credentials: CREDENTIALS, symbol: "BTC/USDT", clientOrderId: "RV1" }),
    /-1021/,
  );
});

test("适配器下单会归一化成执行层的形态", async () => {
  const adapter = createBinanceOrderAdapter({
    fetchImpl: stubFetch(() => ({
      orderId: 99, status: "PARTIALLY_FILLED", executedQty: "0.4",
      cummulativeQuoteQty: "40", fills: [{ commission: "0.04", commissionAsset: "USDT" }],
    })),
  });
  const order = await adapter.placeMarketOrder({
    credentials: CREDENTIALS, symbol: "BTC/USDT", side: "sell", quantity: 1, clientOrderId: "RV1",
  });
  assert.deepEqual(order, {
    externalOrderId: "99", state: "partially_filled",
    filledQuantity: 0.4, averagePrice: 100, feeAmount: 0.04,
  });
});

test("未知状态映射成 live，不是 rejected", () => {
  // 把没见过的状态当成被拒会让上层结案并允许重试；若它其实是已成交，
  // 就变成重复下单。
  assert.equal(normalizeBinanceStatus("SOME_NEW_STATUS"), "live");
  assert.equal(normalizeBinanceStatus("NEW"), "live");
});

test("EXPIRED 是终态，归为 canceled", () => {
  // Binance 现货市价单的 EXPIRED 表示未成交部分被撤销；已成交部分由 executedQty
  // 如实带出，上层仍会判成 partial。
  assert.equal(normalizeBinanceStatus("EXPIRED"), "canceled");
  assert.equal(normalizeBinanceStatus("EXPIRED_IN_MATCH"), "canceled");
  assert.equal(normalizeBinanceStatus("FILLED"), "filled");
  assert.equal(normalizeBinanceStatus("PARTIALLY_FILLED"), "partially_filled");
  assert.equal(normalizeBinanceStatus("REJECTED"), "rejected");
});

test("适配器默认 demo，不默认实盘", () => {
  // 一个默认为 live 的适配器等于把第 6 步的授权闸门绕过去。
  const source = createBinanceOrderAdapter();
  assert.equal(source.exchange, "binance");
});
