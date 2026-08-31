import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createUdunSignature,
  normalizeUdunGatewayBaseUrl,
  parseUdunHttpEnvelope,
  parseUdunAddressResponse,
  parseUdunDepositCallback,
  probeUdunCallbackReadiness,
  readUdunRuntimeConfig,
  testUdunConnectivity,
  udunBaseUnitsToDecimal,
  verifyUdunEnvelope,
} from "../lib/udun-payment.ts";

test("Udun legacy signatures follow the provider's exact body-key-nonce-timestamp contract", () => {
  const body = JSON.stringify({ merchantId: "merchant-1", mainCoinType: 195 });
  const key = "test-api-key";
  const nonce = "nonce-123";
  const timestamp = "1787300000";
  const expected = createHash("md5").update(`${body}${key}${nonce}${timestamp}`).digest("hex");
  assert.equal(createUdunSignature({ body, key, nonce, timestamp }), expected);
  assert.equal(verifyUdunEnvelope({ body, key, nonce, timestamp, sign: expected }), true);
  assert.equal(verifyUdunEnvelope({ body: `${body} `, key, nonce, timestamp, sign: expected }), false);
  assert.equal(verifyUdunEnvelope({ body, key: "wrong-key", nonce, timestamp, sign: expected }), false);
});

test("Udun gateway URLs are HTTPS Udun hosts without credentials, paths, queries, or fragments", () => {
  assert.equal(normalizeUdunGatewayBaseUrl("https://sig11.udun.io"), "https://sig11.udun.io");
  assert.equal(normalizeUdunGatewayBaseUrl("https://node.example.udun.io/"), "https://node.example.udun.io");
  for (const unsafe of [
    "http://sig11.udun.io",
    "https://udun.io.evil.example",
    "https://user:password@sig11.udun.io",
    "https://sig11.udun.io/mch/address/create",
    "https://sig11.udun.io?redirect=https://evil.example",
  ]) assert.throws(() => normalizeUdunGatewayBaseUrl(unsafe), /UDUN_GATEWAY_URL_INVALID/);
});

test("Udun runtime configuration rejects non-numeric merchants, unsafe callbacks and implicit protocol values", () => {
  const base = {
    UDUN_GATEWAY_BASE_URL: "https://sig11.udun.io", UDUN_MERCHANT_ID: "300015",
    UDUN_API_KEY: "test-api-key-123", UDUN_CALLBACK_URL: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
    UDUN_ADDRESS_REQUEST_COIN_FIELD: "mainCoinType",
  };
  const isNotConfigured = (error) => error?.code === "SERVICE_NOT_CONFIGURED";
  assert.equal(readUdunRuntimeConfig(base).addressRequestCoinField, "mainCoinType");
  assert.throws(() => readUdunRuntimeConfig({ ...base, UDUN_MERCHANT_ID: "merchant-1" }), isNotConfigured);
  assert.throws(() => readUdunRuntimeConfig({ ...base, UDUN_CALLBACK_URL: "https://evil.example/api/integrations/payments/udun/webhook" }), isNotConfigured);
  assert.throws(() => readUdunRuntimeConfig({ ...base, UDUN_ADDRESS_REQUEST_COIN_FIELD: "auto" }), isNotConfigured);
});

test("Udun base-unit amounts convert exactly and never use floating point", () => {
  assert.equal(udunBaseUnitsToDecimal("12345678", 6), "12.345678");
  assert.equal(udunBaseUnitsToDecimal("1000000", 6), "1");
  assert.equal(udunBaseUnitsToDecimal("1", 18), "0.000000000000000001");
  assert.throws(() => udunBaseUnitsToDecimal("1.2", 6), /UDUN_AMOUNT_INVALID/);
  assert.throws(() => udunBaseUnitsToDecimal("-1", 6), /UDUN_AMOUNT_INVALID/);
  assert.throws(() => udunBaseUnitsToDecimal("1", 19), /UDUN_DECIMALS_INVALID/);
  assert.throws(() => udunBaseUnitsToDecimal("1".repeat(37), 18), /UDUN_AMOUNT_INVALID/);
});

test("Udun address responses are strict and never synthesize an address", () => {
  assert.deepEqual(parseUdunAddressResponse({ code: 200, message: "SUCCESS", data: { address: "TAddress123", coinType: 195 } }), {
    address: "TAddress123",
    coinType: "195",
  });
  assert.throws(() => parseUdunAddressResponse({ code: 4168, message: "ADDRESS_LIMIT" }), /UDUN_PROVIDER_ERROR:4168/);
  assert.throws(() => parseUdunAddressResponse({ code: 200, data: {} }), /UDUN_ADDRESS_RESPONSE_INVALID/);
});

test("Udun address creation uses the explicitly configured official request field without retrying", async () => {
  let capturedBody = "";
  const response = await (await import("../lib/udun-payment.ts")).requestUdunDepositAddress({
    config: {
      gatewayBaseUrl: "https://sig11.udun.io",
      merchantId: "merchant-1",
      apiKey: "test-api-key",
      callbackUrl: "https://xm.agentnovas.com/api/integrations/payments/udun/webhook",
      addressRequestCoinField: "mainCoinType",
    },
    mainCoinType: "195",
    alias: "deposit-test",
    fetcher: async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ code: 200, data: { address: "TAddress123", coinType: 195 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const envelope = JSON.parse(capturedBody);
  const requestBody = JSON.parse(envelope.body);
  assert.equal(requestBody[0].mainCoinType, 195);
  assert.equal(Object.hasOwn(requestBody[0], "coinType"), false);
  assert.equal(response.address, "TAddress123");

  const legacyBodies = [];
  await (await import("../lib/udun-payment.ts")).requestUdunDepositAddress({
    config: {
      gatewayBaseUrl: "https://sig11.udun.io",
      merchantId: "merchant-1",
      apiKey: "test-api-key",
      callbackUrl: "https://xm.agentnovas.com/api/integrations/payments/udun/webhook",
      addressRequestCoinField: "coinType",
    },
    mainCoinType: "195",
    alias: "deposit-test-legacy",
    fetcher: async (_url, init) => {
      legacyBodies.push(String(init?.body ?? ""));
      return Response.json({ code: 200, data: { address: "TLegacy123", coinType: 195 } });
    },
  });
  assert.equal(legacyBodies.length, 1);
  const legacyRequest = JSON.parse(JSON.parse(legacyBodies[0]).body)[0];
  assert.equal(legacyRequest.coinType, 195);
  assert.equal(Object.hasOwn(legacyRequest, "mainCoinType"), false);

  await assert.rejects((await import("../lib/udun-payment.ts")).requestUdunDepositAddress({
    config: {
      gatewayBaseUrl: "https://sig11.udun.io", merchantId: "merchant-1", apiKey: "test-api-key",
      callbackUrl: "https://xm.agentnovas.com/api/integrations/payments/udun/webhook",
      addressRequestCoinField: "mainCoinType",
    },
    mainCoinType: "195", alias: "mismatched-address-response",
    fetcher: async () => Response.json({ code: 200, data: { address: "WrongNetworkAddress", coinType: 60 } }),
  }), /UDUN_ADDRESS_COIN_MISMATCH/);

  await assert.rejects((await import("../lib/udun-payment.ts")).requestUdunDepositAddress({
    config: {
      gatewayBaseUrl: "https://sig11.udun.io", merchantId: "merchant-1", apiKey: "test-api-key",
      callbackUrl: "https://xm.agentnovas.com/api/integrations/payments/udun/webhook",
      addressRequestCoinField: "mainCoinType",
    },
    mainCoinType: "195", alias: "oversized-address-response",
    fetcher: async () => new Response("{}", { headers: { "content-length": "64001" } }),
  }), /UDUN_ADDRESS_RESPONSE_INVALID/);
});

test("Udun callback envelopes accept official form posts and reject ambiguous fields", () => {
  const body = JSON.stringify({ address: "TAddress123", amount: "1" });
  const form = new URLSearchParams({ timestamp: "1787300000", nonce: "nonce-1", sign: "a".repeat(32), body }).toString();
  assert.deepEqual(parseUdunHttpEnvelope("application/x-www-form-urlencoded; charset=UTF-8", form), {
    timestamp: "1787300000", nonce: "nonce-1", sign: "a".repeat(32), body,
  });
  assert.deepEqual(parseUdunHttpEnvelope("application/json", JSON.stringify({
    timestamp: "1787300000", nonce: "nonce-1", sign: "a".repeat(32), body,
  })), { timestamp: "1787300000", nonce: "nonce-1", sign: "a".repeat(32), body });
  assert.throws(() => parseUdunHttpEnvelope("application/x-www-form-urlencoded", `${form}&nonce=nonce-2`), /UDUN_ENVELOPE_INVALID/);
  assert.throws(() => parseUdunHttpEnvelope("application/x-www-form-urlencoded", `${form}&unexpected=value`), /UDUN_ENVELOPE_INVALID/);
  assert.throws(() => parseUdunHttpEnvelope("text/plain", form), /UDUN_CONTENT_TYPE_INVALID/);
});

test("Udun connectivity proves the configured main/token mapping instead of accepting code 200 alone", async () => {
  const config = {
    gatewayBaseUrl: "https://sig11.udun.io",
    merchantId: "300015",
    apiKey: "test-api-key",
    callbackUrl: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
    addressRequestCoinField: "mainCoinType",
  };
  const fetcher = async () => Response.json({ code: 200, data: [{
    name: "USDT-TRC20", symbol: "USDT", mainCoinType: "195", coinType: "195_TRC20_USDT",
    tokenStatus: "1", decimals: "6", mainSymbol: "TRX",
  }] });
  assert.deepEqual(await testUdunConnectivity({ config, mainCoinType: "195", tokenCoinType: "195_TRC20_USDT", fetcher }), {
    ok: true, coin: { decimals: 6, mainCoinType: "195", coinType: "195_TRC20_USDT", symbol: "USDT" },
  });
  await assert.rejects(
    testUdunConnectivity({ config, mainCoinType: "195", tokenCoinType: "wrong", fetcher }),
    /UDUN_COIN_MAPPING_NOT_SUPPORTED/,
  );
  await assert.rejects(
    testUdunConnectivity({ config, mainCoinType: "195", tokenCoinType: "195_TRC20_USDT", fetcher: async () => Response.json({ code: 200, data: [] }) }),
    /UDUN_COIN_MAPPING_NOT_SUPPORTED/,
  );
});

test("Udun callback readiness probe expects the signed application route, not a generic HTTP success", async () => {
  let capturedUrl = "";
  let capturedType = "";
  const result = await probeUdunCallbackReadiness({
    callbackUrl: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
    allowedHosts: ["main-test.agentnovas.com"],
    fetcher: async (url, init) => {
      capturedUrl = String(url);
      capturedType = new Headers(init?.headers).get("content-type") ?? "";
      return Response.json({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } }, { status: 401 });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(capturedUrl, "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook");
  assert.equal(capturedType, "application/x-www-form-urlencoded");
  await assert.rejects(probeUdunCallbackReadiness({
    callbackUrl: "https://evil.example/api/integrations/payments/udun/webhook",
    allowedHosts: ["main-test.agentnovas.com"], fetcher: async () => Response.json({}, { status: 401 }),
  }), /UDUN_CALLBACK_URL_INVALID/);
  await assert.rejects(probeUdunCallbackReadiness({
    callbackUrl: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
    allowedHosts: ["main-test.agentnovas.com"], fetcher: async () => Response.json({}, { status: 200 }),
  }), /UDUN_CALLBACK_PROBE_FAILED/);
});

test("Udun callbacks accept deposit evidence only and retain provider identifiers", () => {
  const callback = parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123",
    amount: "12345678",
    blockHigh: "102419",
    coinType: "usdt-trc20-id",
    decimals: "6",
    fee: "0",
    mainCoinType: "195",
    status: 3,
    tradeId: "trade-123",
    tradeType: 1,
    txId: "a".repeat(64),
  }));
  assert.equal(callback.amount, "12.345678");
  assert.equal(callback.eventId, "trade-123");
  assert.equal(callback.mainCoinType, "195");
  assert.equal(callback.coinType, "usdt-trc20-id");
  assert.equal(callback.status, 3);
  const officialTableVariant = parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, fee: "0", mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 1, tradeId: "deposit-lower-txid", txid: "lowercase-txid",
  }));
  assert.equal(officialTableVariant.txId, "lowercase-txid");
  assert.throws(() => parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, fee: "0", mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 1, tradeId: "deposit-ambiguous", txId: "camel", txid: "lower",
  })), /UDUN_CALLBACK_TXID_INVALID/);
  assert.throws(() => parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 2, tradeId: "withdrawal", txId: "tx",
  })), /UDUN_CALLBACK_NOT_DEPOSIT/);
  assert.throws(() => parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, fee: "-1", mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 1, tradeId: "deposit", txId: "tx",
  })), /UDUN_CALLBACK_FEE_INVALID/);
});
