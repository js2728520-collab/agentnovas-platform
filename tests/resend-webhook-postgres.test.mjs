import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { markEmailSent } from "../lib/notification-email-worker.ts";
import { applyResendWebhookEvent } from "../lib/resend-webhook.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `resend_webhook_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 6,
  options: `-c search_path=${schema}`,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0016_resend_webhook_sender.sql",
    "0017_notification_outbox_leases.sql",
    "0018_resend_delivery_events.sql",
    "0021_identity_access_hardening.sql",
    "0033_notification_email_suppression.sql",
  ]) {
    const migration = await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8");
    await pool.query(migration);
  }
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE resend_webhook_events, notification_deliveries, users CASCADE");
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, status)
     VALUES ('user-1', 'user-1@example.test', 'hash', 'customer', 'active')`,
  );
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

async function insertDelivery(input = {}) {
  await pool.query(
    `INSERT INTO notification_deliveries
       (id, user_id, channel, category, template_key, status, provider_message_id,
        scheduled_at, lease_owner, lease_expires_at)
     VALUES ($1, 'user-1', 'email', 'account', 'reset_password', $2, $3,
             '2026-08-20T03:00:00.000Z', $4, '2026-08-20T03:01:00.000Z')`,
    [input.id ?? "delivery-1", input.status ?? "queued", input.providerMessageId ?? null, input.workerId ?? "worker-1"],
  );
}

function emailEvent(type, createdAt, input = {}) {
  return {
    type,
    created_at: createdAt,
    data: {
      email_id: input.providerMessageId ?? "provider-1",
      from: "noreply@agentnovas.com",
      tags: { notification_delivery_id: input.deliveryId ?? "delivery-1" },
    },
  };
}

test("a tagged webhook can win the send-response race without Worker state regression", async () => {
  await insertDelivery();
  const webhook = await applyResendWebhookEvent(pool, {
    eventId: "evt-delivered",
    payload: emailEvent("email.delivered", "2026-08-20T03:00:02.000Z"),
    receivedAt: new Date("2026-08-20T03:00:03.000Z"),
  });
  assert.deepEqual(webhook, { duplicate: false, mapped: true, applied: true });

  assert.equal(await markEmailSent(pool, {
    deliveryId: "delivery-1",
    workerId: "worker-1",
    providerMessageId: "provider-1",
    now: new Date("2026-08-20T03:00:04.000Z"),
  }), true);

  const delivery = (await pool.query(
    `SELECT status, provider_message_id, provider_event_type, lease_owner, sent_at
       FROM notification_deliveries WHERE id = 'delivery-1'`,
  )).rows[0];
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.provider_message_id, "provider-1");
  assert.equal(delivery.provider_event_type, "email.delivered");
  assert.equal(delivery.lease_owner, null);
  assert.equal(delivery.sent_at, "2026-08-20T03:00:02.000Z");
});

test("concurrent duplicates and out-of-order events remain idempotent in PostgreSQL", async () => {
  await insertDelivery({ status: "sent", providerMessageId: "provider-1" });
  const duplicateResults = await Promise.all([
    applyResendWebhookEvent(pool, {
      eventId: "evt-opened",
      payload: emailEvent("email.opened", "2026-08-20T03:00:04.000Z"),
    }),
    applyResendWebhookEvent(pool, {
      eventId: "evt-opened",
      payload: emailEvent("email.opened", "2026-08-20T03:00:04.000Z"),
    }),
  ]);
  assert.deepEqual(duplicateResults.map(result => result.duplicate).sort(), [false, true]);

  const older = await applyResendWebhookEvent(pool, {
    eventId: "evt-delivered-older",
    payload: emailEvent("email.delivered", "2026-08-20T03:00:02.000Z"),
  });
  assert.deepEqual(older, { duplicate: false, mapped: true, applied: false });

  const logicallyStale = await applyResendWebhookEvent(pool, {
    eventId: "evt-sent-logically-stale",
    payload: emailEvent("email.sent", "2026-08-20T03:00:06.000Z"),
  });
  assert.deepEqual(logicallyStale, { duplicate: false, mapped: true, applied: false });

  const delivery = (await pool.query(
    `SELECT status, provider_event_type FROM notification_deliveries WHERE id = 'delivery-1'`,
  )).rows[0];
  assert.deepEqual(delivery, { status: "delivered", provider_event_type: "email.opened" });
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM resend_webhook_events")).rows[0].count, 3);
});

test("a conflicting delivery tag and provider id cannot update either delivery", async () => {
  await insertDelivery({ id: "delivery-1", providerMessageId: null });
  await insertDelivery({ id: "delivery-2", providerMessageId: "provider-2", workerId: "worker-2" });
  const result = await applyResendWebhookEvent(pool, {
    eventId: "evt-conflict",
    payload: emailEvent("email.bounced", "2026-08-20T03:00:05.000Z", {
      deliveryId: "delivery-1",
      providerMessageId: "provider-2",
    }),
  });
  assert.deepEqual(result, { duplicate: false, mapped: false, applied: false });
  const rows = (await pool.query("SELECT id, status FROM notification_deliveries ORDER BY id")).rows;
  assert.deepEqual(rows, [
    { id: "delivery-1", status: "queued" },
    { id: "delivery-2", status: "queued" },
  ]);
});

test("bounce and complaint events activate hashed suppression without storing recipient", async () => {
  await insertDelivery({ status: "sent", providerMessageId: "provider-1" });
  const result = await applyResendWebhookEvent(pool, {
    eventId: "evt-complaint",
    payload: emailEvent("email.complained", "2026-08-20T03:00:05.000Z"),
  });
  assert.deepEqual(result, { duplicate: false, mapped: true, applied: true });
  const suppression = (await pool.query("SELECT recipient_hash,reason,active FROM notification_email_suppressions")).rows[0];
  assert.match(suppression.recipient_hash, /^[a-f0-9]{64}$/);
  assert.equal(suppression.reason, "complaint");
  assert.equal(suppression.active, true);
  assert.equal(JSON.stringify(suppression).includes("user-1@example.test"), false);
  const delivery = (await pool.query("SELECT status,last_error FROM notification_deliveries WHERE id='delivery-1'")).rows[0];
  assert.deepEqual(delivery, { status: "failed", last_error: "RESEND_EMAIL_COMPLAINT" });
});
