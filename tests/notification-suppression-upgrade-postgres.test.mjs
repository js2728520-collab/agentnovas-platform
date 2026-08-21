import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `notification_suppression_upgrade_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const recipientHash = (value) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

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
  ]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('user-bounce','bounce@example.test','hash','customer','active'),
      ('user-complaint','complaint@example.test','hash','customer','active'),
      ('user-suppressed','suppressed@example.test','hash','customer','active'),
      ('user-conflict-a','conflict-a@example.test','hash','customer','active'),
      ('user-conflict-b','conflict-b@example.test','hash','customer','active'),
      ('user-wrong-sender','wrong-sender@example.test','hash','customer','active');
    INSERT INTO notification_deliveries(
      id,user_id,channel,category,template_key,status,provider_message_id,scheduled_at
    ) VALUES
      ('delivery-bounce','user-bounce','email','api_security','reset_password','failed','provider-bounce','2026-08-20T00:00:00.000Z'),
      ('delivery-complaint','user-complaint','email','api_security','reset_password','failed','provider-complaint','2026-08-20T00:00:00.000Z'),
      ('delivery-suppressed','user-suppressed','email','api_security','reset_password','failed','provider-suppressed','2026-08-20T00:00:00.000Z'),
      ('delivery-conflict-a','user-conflict-a','email','api_security','reset_password','failed','provider-conflict-a','2026-08-20T00:00:00.000Z'),
      ('delivery-conflict-b','user-conflict-b','email','api_security','reset_password','failed','provider-conflict-b','2026-08-20T00:00:00.000Z'),
      ('delivery-wrong-sender','user-wrong-sender','email','api_security','reset_password','failed','provider-wrong-sender','2026-08-20T00:00:00.000Z');
  `);
  const event = (type, providerMessageId, deliveryId, sender = "noreply@agentnovas.com") => JSON.stringify({
    type,
    created_at: "2026-08-20T03:00:00.000Z",
    data: {
      email_id: providerMessageId,
      from: sender,
      ...(deliveryId ? { tags: { notification_delivery_id: deliveryId } } : {}),
    },
  });
  await pool.query(`
    INSERT INTO resend_webhook_events(
      event_id,event_type,payload_json,event_created_at,provider_message_id,mapped_delivery_id,received_at,processed_at
    ) VALUES
      ('evt-bounce','email.bounced',$1::jsonb,'2026-08-20T03:00:00.000Z','provider-bounce','delivery-bounce','2026-08-20T03:00:01.000Z','2026-08-20T03:00:01.000Z'),
      ('evt-complaint',NULL,$2::jsonb,NULL,NULL,NULL,'2026-08-20T03:00:02.000Z',NULL),
      ('evt-suppressed','email.suppressed',$3::jsonb,'2026-08-20T03:00:03.000Z','provider-suppressed',NULL,'2026-08-20T03:00:03.000Z',NULL),
      ('evt-conflict','email.bounced',$4::jsonb,'2026-08-20T03:00:04.000Z',NULL,NULL,'2026-08-20T03:00:04.000Z',NULL),
      ('evt-wrong-sender','email.complained',$5::jsonb,'2026-08-20T03:00:05.000Z','provider-wrong-sender','delivery-wrong-sender','2026-08-20T03:00:05.000Z',NULL)
  `, [
    event("email.bounced", "provider-bounce", "delivery-bounce"),
    event("email.complained", "provider-complaint", "delivery-complaint"),
    event("email.suppressed", "provider-suppressed", null),
    event("email.bounced", "provider-conflict-b", "delivery-conflict-a"),
    event("email.complained", "provider-wrong-sender", "delivery-wrong-sender", "attacker@example.test"),
  ]);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("0033 safely backfills only trusted historical suppressions as recipient hashes", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0033_notification_email_suppression.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);

  const rows = (await pool.query(`
    SELECT recipient_hash,reason,source_event_id,active
      FROM notification_email_suppressions
     ORDER BY source_event_id
  `)).rows;
  assert.deepEqual(rows, [
    { recipient_hash: recipientHash("bounce@example.test"), reason: "bounce", source_event_id: "evt-bounce", active: true },
    { recipient_hash: recipientHash("complaint@example.test"), reason: "complaint", source_event_id: "evt-complaint", active: true },
    { recipient_hash: recipientHash("suppressed@example.test"), reason: "provider_suppression", source_event_id: "evt-suppressed", active: true },
  ]);
  const serialized = JSON.stringify(rows);
  for (const address of [
    "bounce@example.test",
    "complaint@example.test",
    "suppressed@example.test",
    "conflict-a@example.test",
    "conflict-b@example.test",
    "wrong-sender@example.test",
  ]) assert.equal(serialized.includes(address), false);
});

test("0033 contract hashes in SQL and never adds a plaintext recipient column", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0033_notification_email_suppression.sql", import.meta.url), "utf8");
  assert.match(migration, /encode\(sha256\(convert_to\(/);
  assert.match(migration, /email\.bounced/);
  assert.match(migration, /email\.complained/);
  assert.match(migration, /email\.suppressed/);
  assert.match(migration, /noreply@agentnovas\.com/);
  assert.doesNotMatch(migration, /ADD COLUMN[^;]*(?:email|recipient)(?!_hash)/i);
});
