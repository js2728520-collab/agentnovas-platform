import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  applyResendWebhookEvent,
  parseResendDeliveryEvent,
  shouldApplyResendDeliveryEvent,
  verifyResendWebhook,
} from "../lib/resend-webhook.ts";

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

test("Resend delivery events map only bounded canonical sender payloads", () => {
  const delivered = parseResendDeliveryEvent({
    type: "email.delivered",
    created_at: "2026-08-20T03:00:00.000Z",
    data: {
      email_id: "provider-1",
      from: "noreply@agentnovas.com",
      tags: { notification_delivery_id: "delivery-1" },
    },
  });
  assert.deepEqual(delivered, {
    eventType: "email.delivered",
    eventCreatedAt: "2026-08-20T03:00:00.000Z",
    providerMessageId: "provider-1",
    deliveryId: "delivery-1",
    nextStatus: "delivered",
    errorCode: null,
    rank: 30,
  });

  assert.equal(parseResendDeliveryEvent({ type: "domain.updated", data: {} }), null);
  assert.throws(() => parseResendDeliveryEvent({
    type: "email.bounced",
    created_at: "not-a-date",
    data: { email_id: "provider-1", from: "noreply@agentnovas.com" },
  }), /INVALID_WEBHOOK_PAYLOAD/);
  assert.throws(() => parseResendDeliveryEvent({
    type: "email.delivered",
    created_at: "2026-08-20T03:00:00.000Z",
    data: { email_id: "provider-1", from: "attacker@example.com" },
  }), /INVALID_WEBHOOK_PAYLOAD/);
});

test("complaints are permanent failures and never count as delivered", () => {
  const complaint = parseResendDeliveryEvent({
    type: "email.complained",
    created_at: "2026-08-20T03:00:00.000Z",
    data: { email_id: "provider-1", from: "noreply@agentnovas.com" },
  });
  assert.equal(complaint.nextStatus, "failed");
  assert.equal(complaint.errorCode, "RESEND_EMAIL_COMPLAINT");
});

test("Resend event ordering never lets an older or lower-priority event regress delivery state", () => {
  const current = { eventType: "email.opened", eventCreatedAt: "2026-08-20T03:00:02.000Z" };
  const olderDelivery = parseResendDeliveryEvent({
    type: "email.delivered",
    created_at: "2026-08-20T03:00:01.000Z",
    data: { email_id: "provider-1", from: "noreply@agentnovas.com" },
  });
  const newerFailure = parseResendDeliveryEvent({
    type: "email.bounced",
    created_at: "2026-08-20T03:00:03.000Z",
    data: { email_id: "provider-1", from: "noreply@agentnovas.com" },
  });
  const sameTimeSent = parseResendDeliveryEvent({
    type: "email.sent",
    created_at: "2026-08-20T03:00:02.000Z",
    data: { email_id: "provider-1", from: "noreply@agentnovas.com" },
  });
  assert.equal(shouldApplyResendDeliveryEvent(current, olderDelivery), false);
  assert.equal(shouldApplyResendDeliveryEvent(current, sameTimeSent), false);
  assert.equal(shouldApplyResendDeliveryEvent(current, newerFailure), true);
  assert.equal(shouldApplyResendDeliveryEvent({ eventType: null, eventCreatedAt: null }, olderDelivery), true);
});

test("verified Resend events are persisted and applied in one transaction", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (/INSERT INTO resend_webhook_events/.test(sql)) return { rows: [{ event_id: "evt-1" }], rowCount: 1 };
      if (/SELECT delivery\.id, delivery\.status, delivery\.provider_message_id/.test(sql)) {
        return { rows: [{ id: "delivery-1", status: "sent", provider_message_id: "provider-1", provider_event_type: null, provider_event_at: null, recipient: "person@example.com" }] };
      }
      if (/UPDATE notification_deliveries/.test(sql)) return { rows: [{ id: "delivery-1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const result = await applyResendWebhookEvent({ connect: async () => client }, {
    eventId: "evt-1",
    payload: {
      type: "email.delivered",
      created_at: "2026-08-20T03:00:00.000Z",
      data: {
        email_id: "provider-1",
        from: "noreply@agentnovas.com",
        tags: { notification_delivery_id: "delivery-1" },
      },
    },
    receivedAt: new Date("2026-08-20T03:00:01.000Z"),
  });
  assert.deepEqual(result, { duplicate: false, mapped: true, applied: true });
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  const update = queries.find(query => /UPDATE notification_deliveries/.test(query.sql));
  assert.equal(update.parameters[2], "delivered");
  assert.equal(update.parameters[4], "email.delivered");
});

test("duplicate Resend events commit without applying the delivery twice", async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (/INSERT INTO resend_webhook_events/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const result = await applyResendWebhookEvent({ connect: async () => client }, {
    eventId: "evt-duplicate",
    payload: { type: "domain.updated", data: {} },
  });
  assert.deepEqual(result, { duplicate: true, mapped: false, applied: false });
  assert.equal(queries.some(query => /notification_deliveries/.test(query.sql)), false);
  assert.equal(queries.at(-1).sql, "COMMIT");
});
