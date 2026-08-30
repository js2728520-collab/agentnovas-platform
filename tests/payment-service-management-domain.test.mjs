import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePaymentSecretRequestCommand,
  paymentActivationGate,
} from "../packages/payments/src/udun-service-management.ts";

test("payment secret requests are exact, bounded, encrypted-only install or rotate commands", () => {
  const envelope = {
    version: "v1", keyId: "payment-broker-2026-08",
    wrappedKey: "A".repeat(342), iv: "A".repeat(16), ciphertext: "A".repeat(256),
  };
  assert.deepEqual(normalizePaymentSecretRequestCommand({
    operation: "rotate", envelope, reason: "轮换优盾测试商户配置并重新执行全部 Gate",
  }), { operation: "rotate", envelope, reason: "轮换优盾测试商户配置并重新执行全部 Gate" });
  assert.throws(() => normalizePaymentSecretRequestCommand({
    operation: "read", envelope, reason: "禁止读取配置",
  }), /PAYMENT_SECRET_OPERATION_INVALID/);
  assert.throws(() => normalizePaymentSecretRequestCommand({
    operation: "install", envelope: { ...envelope, apiKey: "never" }, reason: "拒绝额外字段",
  }), /PAYMENT_SECRET_ENVELOPE_FIELDS_INVALID/);
});

test("payment activation requires current secret, broker, provider and callback evidence", () => {
  const now = new Date("2026-08-29T03:00:00.000Z");
  const ready = {
    secretConfigured: true, brokerAvailable: true, coinMappingConfigured: true,
    providerAuthorized: true, configurationVersion: "payment-v1",
    providerTest: { status: "passed", at: "2026-08-29T02:00:00.000Z", configurationVersion: "payment-v1" },
    callbackTest: { status: "passed", at: "2026-08-29T02:10:00.000Z", configurationVersion: "payment-v1" },
  };
  assert.deepEqual(paymentActivationGate(ready, now), { ready: true, blockers: [] });
  assert.deepEqual(paymentActivationGate({ ...ready, callbackTest: { ...ready.callbackTest, status: "failed" } }, now), {
    ready: false, blockers: ["CALLBACK_TEST_REQUIRED"],
  });
  assert.deepEqual(paymentActivationGate({ ...ready, providerTest: { ...ready.providerTest, configurationVersion: "old" } }, now), {
    ready: false, blockers: ["PROVIDER_TEST_CONFIGURATION_STALE"],
  });
  assert.deepEqual(paymentActivationGate(ready, new Date("2026-08-31T03:00:00.000Z")), {
    ready: false, blockers: ["PROVIDER_TEST_EXPIRED", "CALLBACK_TEST_EXPIRED"],
  });
});
