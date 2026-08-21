import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createUdunSignature,
  normalizeUdunGatewayBaseUrl,
  parseUdunAddressResponse,
  parseUdunDepositCallback,
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

test("Udun address creation uses the provider's documented coinType request field", async () => {
  let capturedBody = "";
  const response = await (await import("../lib/udun-payment.ts")).requestUdunDepositAddress({
    config: {
      gatewayBaseUrl: "https://sig11.udun.io",
      merchantId: "merchant-1",
      apiKey: "test-api-key",
      callbackUrl: "https://xm.agentnovas.com/api/integrations/payments/udun/webhook",
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
  assert.equal(requestBody[0].coinType, 195);
  assert.equal(Object.hasOwn(requestBody[0], "mainCoinType"), false);
  assert.equal(response.address, "TAddress123");
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
  assert.throws(() => parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 2, tradeId: "withdrawal", txId: "tx",
  })), /UDUN_CALLBACK_NOT_DEPOSIT/);
  assert.throws(() => parseUdunDepositCallback(JSON.stringify({
    address: "TAddress123", amount: "1", decimals: 6, fee: "-1", mainCoinType: 195,
    coinType: "token", status: 3, tradeType: 1, tradeId: "deposit", txId: "tx",
  })), /UDUN_CALLBACK_FEE_INVALID/);
});
