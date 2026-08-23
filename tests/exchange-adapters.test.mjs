import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyExchangeConnection, verifyOkxConnection } from "../lib/exchange-adapters.ts";
import { readFile } from "node:fs/promises";

import { getOkxDemoOrder, okxInstrumentId, placeOkxDemoMarketOrder } from "../lib/okx-demo-execution.ts";

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

// —— OKX 实盘 ——
//
// OKX 的模拟盘与实盘是同一套 REST API，区别只有 x-simulated-trading 这一个请求头。
// 于是「有没有实盘适配器」这件事，实际取决于一个布尔值有没有被传下去——
// 而两个方向传错都会造成真实损失，且都不会报错。

test("不传环境时默认走模拟盘", async () => {
  // 默认走实盘的执行器等于把 execution_live_routing 的灰度闸门绕过去了。
  const requests = [];
  await placeOkxDemoMarketOrder({
    credentials: { apiKey: "k", secretKey: "s", passphrase: "p" },
    symbol: "BTCUSDT", side: "buy", notionalUsdt: 25, clientOrderId: "ANEDEF001",
    baseUrl: "https://example.okx.test",
    fetchImpl: async (url, init) => {
      requests.push(init);
      if (init.method === "POST") return Response.json({ code: "0", data: [{ ordId: "1", clOrdId: "ANEDEF001", sCode: "0" }] });
      return Response.json({ code: "0", data: [{ ordId: "1", clOrdId: "ANEDEF001", instId: "BTC-USDT", side: "buy", state: "filled", avgPx: "60000", accFillSz: "0.0004", fee: "-0.01", feeCcy: "USDT" }] });
    },
  });
  assert.equal(requests[0].headers["x-simulated-trading"], "1");
});

test("environment: live 时不带模拟盘请求头", async () => {
  // 带着它发实盘单，客户以为自己有实盘仓位，而交易所里是模拟仓位。
  const requests = [];
  await placeOkxDemoMarketOrder({
    credentials: { apiKey: "k", secretKey: "s", passphrase: "p" },
    symbol: "BTCUSDT", side: "buy", notionalUsdt: 25, clientOrderId: "ANELIVE01",
    baseUrl: "https://example.okx.test",
    environment: "live",
    fetchImpl: async (url, init) => {
      requests.push(init);
      if (init.method === "POST") return Response.json({ code: "0", data: [{ ordId: "2", clOrdId: "ANELIVE01", sCode: "0" }] });
      return Response.json({ code: "0", data: [{ ordId: "2", clOrdId: "ANELIVE01", instId: "BTC-USDT", side: "buy", state: "filled", avgPx: "60000", accFillSz: "0.0004", fee: "-0.01", feeCcy: "USDT" }] });
    },
  });
  assert.equal(requests[0].headers["x-simulated-trading"], undefined);
  // 其余部分必须与模拟盘完全一致——两条路差别只该是这一个头。
  assert.equal(JSON.parse(requests[0].body).tdMode, "cash");
  assert.equal(JSON.parse(requests[0].body).ordType, "market");
});

test("查单同样按环境走，不会拿实盘单去模拟盘查", async () => {
  // 对账拿模拟盘去查一笔实盘单，只会查不到——而「查不到」在采信窗口内会被判成
  // 从未下单，然后重试。重复下单。
  const requests = [];
  await getOkxDemoOrder({
    credentials: { apiKey: "k", secretKey: "s", passphrase: "p" },
    symbol: "BTCUSDT", clientOrderId: "ANELIVE01",
    baseUrl: "https://example.okx.test",
    environment: "live",
    fetchImpl: async (url, init) => {
      requests.push(init);
      return Response.json({ code: "0", data: [{ ordId: "2", clOrdId: "ANELIVE01", instId: "BTC-USDT", side: "buy", state: "filled", avgPx: "60000", accFillSz: "0.0004", fee: "-0.01", feeCcy: "USDT" }] });
    },
  });
  assert.equal(requests[0].headers["x-simulated-trading"], undefined);
});

test("okx/live 与 binance/live 都注册了适配器", async () => {
  // 缺适配器不是「订单不存在」：对账里它被归为 query_failed 而不是 order_absent，
  // 但对下单来说它是一条永远失败的路径，客户的部署会每一轮都失败。
  const source = await readFile(new URL("../lib/execution/server/live-execution-service.ts", import.meta.url), "utf8");
  for (const key of ['adapterKey("okx", "live")', 'adapterKey("binance", "live")']) {
    assert.ok(source.includes(key), `${key} 未注册`);
  }
});
