import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifyResendWebhook } from "../lib/resend-webhook.ts";

function signature(body, eventId, timestamp, secretBytes) {
  return createHmac("sha256", secretBytes)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64");
}

test("Resend webhook verification requires a fresh valid Svix signature", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_1" } });
  const eventId = "evt_1";
  const timestamp = "1720000000";
  const secret = "test-webhook-secret";
  const secretBytes = Buffer.from(secret, "utf8");
  assert.deepEqual(verifyResendWebhook({
    body,
    eventId,
    timestamp,
    signature: `v1,${signature(body, eventId, timestamp, secretBytes)}`,
    secret,
    nowSeconds: 1720000100,
  }), { eventId, timestamp: 1720000000 });
  assert.throws(() => verifyResendWebhook({ body, eventId, timestamp, signature: "v1,bad", secret, nowSeconds: 1720000100 }), /WEBHOOK_SIGNATURE_INVALID/);
  assert.throws(() => verifyResendWebhook({ body, eventId, timestamp: "1710000000", signature: `v1,${signature(body, eventId, "1710000000", secretBytes)}`, secret, nowSeconds: 1720000100 }), /WEBHOOK_TIMESTAMP_EXPIRED/);
});

test("Resend webhook verification decodes whsec secrets and accepts any valid v1 candidate", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "msg_2" } });
  const eventId = "evt_2";
  const timestamp = "1720000000";
  const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const validSignature = signature(body, eventId, timestamp, secretBytes);

  assert.deepEqual(verifyResendWebhook({
    body,
    eventId,
    timestamp,
    signature: `v1,bad v1,${validSignature}`,
    secret,
    nowSeconds: 1720000001,
  }), { eventId, timestamp: 1720000000 });
  assert.throws(() => verifyResendWebhook({
    body,
    eventId,
    timestamp,
    signature: `v1,${validSignature}`,
    secret: "whsec_not-base64!",
    nowSeconds: 1720000001,
  }), /WEBHOOK_SECRET_INVALID/);
});
