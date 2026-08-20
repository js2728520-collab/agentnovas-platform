import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  PLATFORM_DEMO_ENDPOINTS,
  PlatformDemoResponseError,
  createPlatformDemoAdapter,
  createPlatformDemoFetchTransport,
  deterministicDemoClientOrderId,
} from "../lib/platform-demo-adapters.ts";

const now = () => new Date("2026-08-20T00:00:00.000Z");

function fixtureTransport(fixtures) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const fixture = fixtures.shift();
      if (!fixture) throw new Error("unexpected request");
      return fixture;
    },
  };
}

test("platform demo endpoints are immutable demo-only spot environments", async () => {
  assert.deepEqual(PLATFORM_DEMO_ENDPOINTS, {
    okx: "https://openapi.okx.com",
    binance: "https://testnet.binance.vision",
    bybit: "https://api-demo.bybit.com",
  });
  const id = deterministicDemoClientOrderId({ provider: "binance", strategyCode: "ai_balanced", decisionRoundId: "round-a" });
  assert.equal(id, deterministicDemoClientOrderId({ provider: "binance", strategyCode: "ai_balanced", decisionRoundId: "round-a" }));
  assert.match(id, /^rv[a-f0-9]+$/);
  assert.ok(id.length <= 32);

  const guardedTransport = createPlatformDemoFetchTransport();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("fixture forbids network");
  };
  try {
    for (const request of [
      { method: "POST", url: "https://api.binance.com/api/v3/order", headers: {} },
      { method: "POST", url: `${PLATFORM_DEMO_ENDPOINTS.okx}/api/v5/asset/withdrawal`, headers: { "x-simulated-trading": "1" } },
      { method: "POST", url: `${PLATFORM_DEMO_ENDPOINTS.bybit}/v5/order/create`, headers: {}, body: JSON.stringify({ category: "linear", isLeverage: 1 }) },
    ]) {
      await assert.rejects(guardedTransport.request(request), /白名单|现货|Demo|禁止/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
});

test("external demo writes are disabled by default and never reach transport", async () => {
  const transport = fixtureTransport([]);
  const adapter = createPlatformDemoAdapter("binance", {
    apiKey: "fixture-key",
    secret: "fixture-secret",
  }, { transport, now });
  await assert.rejects(adapter.placeOrder({
    symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678",
  }), /默认关闭|disabled/i);
  await assert.rejects(adapter.cancelOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" }), /默认关闭|disabled/i);
  assert.equal(transport.requests.length, 0);
});

test("OKX demo signs every private request and always sends x-simulated-trading: 1", async () => {
  const transport = fixtureTransport([
    { status: 200, json: { code: "0", data: [{ totalEq: "1000" }] } },
    { status: 200, json: { code: "0", data: [{ ordId: "okx-order", clOrdId: "rv12345678", sCode: "0" }] } },
    { status: 200, json: { code: "0", data: [{ ordId: "okx-order", clOrdId: "rv12345678", state: "live", accFillSz: "0" }] } },
    { status: 200, json: { code: "0", data: [{ ordId: "okx-order", clOrdId: "rv12345678", sCode: "0" }] } },
    { status: 200, json: { code: "0", data: [{ tradeId: "fill-a", ordId: "okx-order", fillSz: "0.001", fillPx: "10000", fee: "-0.01", feeCcy: "USDT", ts: "1787184000000" }] } },
  ]);
  const adapter = createPlatformDemoAdapter("okx", {
    apiKey: "fixture-key", secret: "fixture-secret", passphrase: "fixture-passphrase",
  }, { transport, now, externalWritesEnabled: true });
  assert.equal((await adapter.verify()).status, "verified");
  assert.equal((await adapter.placeOrder({ symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678" })).providerOrderId, "okx-order");
  assert.equal((await adapter.getOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" })).status, "open");
  assert.equal((await adapter.cancelOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" })).status, "cancelled");
  assert.equal((await adapter.listFills({ symbol: "BTCUSDT", providerOrderId: "okx-order" })).length, 1);
  for (const request of transport.requests) {
    assert.equal(new URL(request.url).origin, PLATFORM_DEMO_ENDPOINTS.okx);
    assert.equal(request.headers["x-simulated-trading"], "1");
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const body = request.body || "";
    const expected = createHmac("sha256", "fixture-secret")
      .update(`${now().toISOString()}${request.method}${path}${body}`)
      .digest("base64");
    assert.equal(request.headers["OK-ACCESS-SIGN"], expected);
  }
  const placed = JSON.parse(transport.requests[1].body);
  assert.deepEqual({ instId: placed.instId, tdMode: placed.tdMode, ordType: placed.ordType, tgtCcy: placed.tgtCcy, sz: placed.sz }, {
    instId: "BTC-USDT", tdMode: "cash", ordType: "market", tgtCcy: "quote_ccy", sz: "10",
  });
});

test("Binance adapter uses only Spot Test Network HMAC endpoints", async () => {
  const transport = fixtureTransport([
    { status: 200, json: { accountType: "SPOT", canTrade: true } },
    { status: 200, json: { symbol: "BTCUSDT", orderId: 42, clientOrderId: "rv12345678", status: "NEW" } },
    { status: 200, json: { symbol: "BTCUSDT", orderId: 42, clientOrderId: "rv12345678", status: "FILLED", executedQty: "0.001", cummulativeQuoteQty: "10" } },
    { status: 200, json: { symbol: "BTCUSDT", orderId: 42, clientOrderId: "rv12345678", status: "CANCELED" } },
    { status: 200, json: [{ id: 7, orderId: 42, qty: "0.001", quoteQty: "10", commission: "0.01", commissionAsset: "USDT", time: 1787184000000 }] },
  ]);
  const adapter = createPlatformDemoAdapter("binance", {
    apiKey: "fixture-key", secret: "fixture-secret",
  }, { transport, now, externalWritesEnabled: true });
  await adapter.verify();
  await adapter.placeOrder({ symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678" });
  await adapter.getOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" });
  await adapter.cancelOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" });
  await adapter.listFills({ symbol: "BTCUSDT", providerOrderId: "42" });
  for (const request of transport.requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, PLATFORM_DEMO_ENDPOINTS.binance);
    assert.match(url.pathname, /^\/api\/v3\/(account|order|myTrades)$/);
    const signature = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    assert.equal(signature, createHmac("sha256", "fixture-secret").update(url.searchParams.toString()).digest("hex"));
  }
  const placed = new URL(transport.requests[1].url);
  assert.equal(placed.searchParams.get("quoteOrderQty"), "10");
  assert.equal(placed.searchParams.get("type"), "MARKET");
});

test("Bybit demo forces category=spot and isLeverage=0 with v5 signing", async () => {
  const transport = fixtureTransport([
    { status: 200, json: { retCode: 0, retMsg: "OK", result: { list: [{ accountType: "UNIFIED" }] } } },
    { status: 200, json: { retCode: 0, retMsg: "OK", result: { orderId: "bybit-order", orderLinkId: "rv12345678" } } },
    { status: 200, json: { retCode: 0, retMsg: "OK", result: { list: [{ orderId: "bybit-order", orderLinkId: "rv12345678", orderStatus: "New", cumExecQty: "0", cumExecValue: "0" }] } } },
    { status: 200, json: { retCode: 0, retMsg: "OK", result: { orderId: "bybit-order", orderLinkId: "rv12345678" } } },
    { status: 200, json: { retCode: 0, retMsg: "OK", result: { list: [{ execId: "fill-a", orderId: "bybit-order", execQty: "0.001", execPrice: "10000", execFee: "0.01", feeCurrency: "USDT", execTime: "1787184000000" }] } } },
  ]);
  const adapter = createPlatformDemoAdapter("bybit", {
    apiKey: "fixture-key", secret: "fixture-secret",
  }, { transport, now, externalWritesEnabled: true });
  await adapter.verify();
  await adapter.placeOrder({ symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678" });
  await adapter.getOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" });
  await adapter.cancelOrder({ symbol: "BTCUSDT", clientOrderId: "rv12345678" });
  await adapter.listFills({ symbol: "BTCUSDT", providerOrderId: "bybit-order" });
  for (const request of transport.requests) assert.equal(new URL(request.url).origin, PLATFORM_DEMO_ENDPOINTS.bybit);
  const placed = JSON.parse(transport.requests[1].body);
  assert.deepEqual({ category: placed.category, isLeverage: placed.isLeverage, marketUnit: placed.marketUnit, qty: placed.qty }, {
    category: "spot", isLeverage: 0, marketUnit: "quoteCoin", qty: "10",
  });
  const payload = transport.requests[1].body;
  const expected = createHmac("sha256", "fixture-secret")
    .update(`${now().getTime()}fixture-key5000${payload}`)
    .digest("hex");
  assert.equal(transport.requests[1].headers["X-BAPI-SIGN"], expected);
});

test("malformed provider responses are rejected instead of treated as success", async () => {
  const transport = fixtureTransport([{ status: 200, json: { code: "0", data: [{}] } }]);
  const adapter = createPlatformDemoAdapter("okx", {
    apiKey: "fixture-key", secret: "fixture-secret", passphrase: "fixture-passphrase",
  }, { transport, now, externalWritesEnabled: true });
  await assert.rejects(adapter.placeOrder({
    symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678",
  }), /响应|order/i);

  const mismatchedOrderTransport = fixtureTransport([{
    status: 200,
    json: { code: "0", data: [{ ordId: "okx-order", clOrdId: "rv87654321", sCode: "0" }] },
  }]);
  const mismatchedOrderAdapter = createPlatformDemoAdapter("okx", {
    apiKey: "fixture-key", secret: "fixture-secret", passphrase: "fixture-passphrase",
  }, { transport: mismatchedOrderTransport, now, externalWritesEnabled: true });
  await assert.rejects(mismatchedOrderAdapter.placeOrder({
    symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678",
  }), /client order|不匹配/i);

  const unsupportedFeeTransport = fixtureTransport([{
    status: 200,
    json: [{
      id: 7, orderId: 42, qty: "0.001", quoteQty: "10",
      commission: "0.00001", commissionAsset: "BNB", time: 1787184000000,
    }],
  }]);
  const binance = createPlatformDemoAdapter("binance", {
    apiKey: "fixture-key", secret: "fixture-secret",
  }, { transport: unsupportedFeeTransport, now, externalWritesEnabled: true });
  assert.deepEqual((await binance.listFills({ symbol: "BTCUSDT", providerOrderId: "42" }))[0], {
    fillId: "7", providerOrderId: "42", baseQuantity: 0.001, price: 10_000,
    feeAmount: 0.00001, feeCurrency: "BNB", feeUsdt: null,
    observedAt: "2026-08-20T00:00:00.000Z",
  });

  const mismatchedFillTransport = fixtureTransport([{
    status: 200,
    json: [{
      id: 8, orderId: 99, qty: "0.001", quoteQty: "10",
      commission: "0.01", commissionAsset: "USDT", time: 1787184000000,
    }],
  }]);
  const mismatchedFillAdapter = createPlatformDemoAdapter("binance", {
    apiKey: "fixture-key", secret: "fixture-secret",
  }, { transport: mismatchedFillTransport, now, externalWritesEnabled: true });
  await assert.rejects(
    mismatchedFillAdapter.listFills({ symbol: "BTCUSDT", providerOrderId: "42" }),
    /provider order|不匹配/i,
  );
});

test("demo market sells fail closed before transport without a provable 10 USDT cap and filters", async () => {
  for (const [provider, credentials] of [
    ["okx", { apiKey: "fixture-key", secret: "fixture-secret", passphrase: "fixture-passphrase" }],
    ["binance", { apiKey: "fixture-key", secret: "fixture-secret" }],
    ["bybit", { apiKey: "fixture-key", secret: "fixture-secret" }],
  ]) {
    const transport = fixtureTransport([]);
    const adapter = createPlatformDemoAdapter(provider, credentials, {
      transport, now, externalWritesEnabled: true,
    });
    await assert.rejects(adapter.placeOrder({
      symbol: "BTCUSDT", side: "sell", quoteAmountUsdt: 10,
      baseQuantity: 0.001, clientOrderId: "rv12345678",
    }), /sell|卖出|10 USDT|filter/i);
    assert.equal(transport.requests.length, 0);
  }
});

test("a transport failure after an order write is classified as execution-unknown", async () => {
  let requests = 0;
  const adapter = createPlatformDemoAdapter("binance", {
    apiKey: "fixture-key", secret: "fixture-secret",
  }, {
    now,
    externalWritesEnabled: true,
    transport: {
      async request() {
        requests += 1;
        throw new Error("fixture connection reset after write");
      },
    },
  });
  await assert.rejects(
    adapter.placeOrder({
      symbol: "BTCUSDT", side: "buy", quoteAmountUsdt: 10, clientOrderId: "rv12345678",
    }),
    (error) => error instanceof PlatformDemoResponseError && error.unknownExecutionState === true,
  );
  assert.equal(requests, 1);
});
