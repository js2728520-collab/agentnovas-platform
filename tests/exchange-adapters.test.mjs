import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyExchangeConnection, verifyOkxConnection } from "../lib/exchange-adapters.ts";
import { okxInstrumentId, placeOkxDemoMarketOrder } from "../lib/okx-demo-execution.ts";

const credentials = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key",
  passphrase: "test-passphrase",
};

test("OKX demo permission check signs the official account config request", async () => {
  const timestamp = "2026-08-13T01:02:03.456Z";
  let request;
  const result = await verifyOkxConnection({
    credentials,
    environment: "demo",
    now: () => new Date(timestamp),
    baseUrl: "https://example.okx.test",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ code: "0", msg: "", data: [{ perm: "read_only,trade", acctLv: "2", posMode: "net_mode" }] });
    },
  });

  const expected = createHmac("sha256", credentials.secretKey)
    .update(`${timestamp}GET/api/v5/account/config`)
    .digest("base64");
  assert.equal(request.url, "https://example.okx.test/api/v5/account/config");
  assert.equal(request.init.headers["OK-ACCESS-SIGN"], expected);
  assert.equal(request.init.headers["x-simulated-trading"], "1");
  assert.equal(result.canRead, true);
  assert.equal(result.canTrade, true);
  assert.equal(result.canWithdraw, false);
});

test("OKX live check never sends the simulated trading header", async () => {
  let headers;
  await verifyOkxConnection({
    credentials,
    environment: "live",
    baseUrl: "https://example.okx.test",
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return Response.json({ code: "0", msg: "", data: [{ perm: "read_only" }] });
    },
  });
  assert.equal(headers["x-simulated-trading"], undefined);
});

test("registered exchanges keep local demo checks and use an official signed live check", async () => {
  const result = await verifyExchangeConnection({ exchange: "BINANCE", credentials, environment: "demo" });
  assert.equal(result.verificationMode, "local-demo");
  assert.equal(result.canRead, true);
  assert.equal(result.canTrade, true);
  assert.equal(result.canWithdraw, false);

  let request;
  const live = await verifyExchangeConnection({
    exchange: "BINANCE",
    credentials,
    environment: "live",
    baseUrl: "https://example.binance.test",
    now: () => new Date("2026-08-13T01:02:03.456Z"),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ canTrade: true, canWithdraw: false, accountType: "SPOT" });
    },
  });
  assert.equal(live.verificationMode, "official");
  assert.equal(live.canTrade, true);
  assert.equal(live.canWithdraw, false);
  assert.match(request.url, /^https:\/\/example\.binance\.test\/api\/v3\/account\?/);
  assert.equal(request.init.headers["X-MBX-APIKEY"], credentials.apiKey);
});

test("OKX executor places only a simulated spot market order and synchronizes its receipt", async () => {
  const requests = [];
  const order = await placeOkxDemoMarketOrder({
    credentials,
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsdt: 25,
    clientOrderId: "ANETEST001",
    baseUrl: "https://example.okx.test",
    now: () => new Date("2026-08-13T01:02:03.456Z"),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === "POST") return Response.json({ code: "0", data: [{ ordId: "123456", clOrdId: "ANETEST001", sCode: "0", sMsg: "" }] });
      return Response.json({ code: "0", data: [{ ordId: "123456", clOrdId: "ANETEST001", instId: "BTC-USDT", side: "buy", state: "filled", avgPx: "60000", accFillSz: "0.000416", fee: "-0.01", feeCcy: "USDT" }] });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://example.okx.test/api/v5/trade/order");
  assert.equal(requests[0].init.headers["x-simulated-trading"], "1");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    instId: "BTC-USDT",
    tdMode: "cash",
    side: "buy",
    ordType: "market",
    sz: "25",
    tgtCcy: "quote_ccy",
    clOrdId: "ANETEST001",
  });
  assert.equal(order.state, "filled");
  assert.equal(order.orderId, "123456");
  assert.equal(order.filledQuantity, 0.000416);
});

test("OKX instrument conversion rejects ambiguous products", () => {
  assert.equal(okxInstrumentId("ETH/USDT"), "ETH-USDT");
  assert.throws(() => okxInstrumentId("NOT_A_MARKET"), /暂不支持/);
});
