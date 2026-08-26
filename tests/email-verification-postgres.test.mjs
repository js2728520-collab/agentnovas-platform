import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { queueEmailVerificationRequest } from "../lib/email-verification.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `email_verification_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const environment = {
  NOTIFICATION_TOKEN_ENCRYPTION_KEY: "email-verification-test-key-longer-than-thirty-two-characters",
};

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0021_identity_access_hardening.sql",
    "0040_client_identity_rls.sql",
    "0066_client_email_and_device_security.sql",
  ]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('pending-email','pending@example.test','hash','customer','pending'),
      ('active-email','active@example.test','hash','customer','active')
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("resend is non-enumerating, rotates pending capabilities and recovers active legacy accounts", async () => {
  const first = await queueEmailVerificationRequest(pool, {
    email: "pending@example.test",
    now: new Date("2026-08-23T02:00:00.000Z"),
    environment,
  });
  const second = await queueEmailVerificationRequest(pool, {
    email: "pending@example.test",
    now: new Date("2026-08-23T02:05:00.000Z"),
    environment,
  });
  const unknown = await queueEmailVerificationRequest(pool, {
    email: "unknown@example.test",
    now: new Date("2026-08-23T02:05:00.000Z"),
    environment,
  });
  const active = await queueEmailVerificationRequest(pool, {
    email: "active@example.test",
    now: new Date("2026-08-23T02:05:00.000Z"),
    environment,
  });
  assert.deepEqual([first, second, unknown, active], [
    { queued: true }, { queued: true }, { queued: false }, { queued: true },
  ]);

  const tokens = (await pool.query(`
    SELECT token_hash,used_at FROM auth_tokens
    WHERE user_id='pending-email' AND purpose='verify_email' ORDER BY created_at,id
  `)).rows;
  assert.equal(tokens.length, 2);
  assert.ok(tokens[0].used_at);
  assert.equal(tokens[1].used_at, null);
  assert.match(tokens[1].token_hash, /^[a-f0-9]{64}$/);

  const deliveries = (await pool.query(`
    SELECT payload_json,secret_kind,secret_expires_at FROM notification_deliveries
    WHERE user_id='pending-email' ORDER BY scheduled_at,id
  `)).rows;
  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    const payload = JSON.parse(delivery.payload_json);
    assert.match(payload.encryptedToken, /^v1\./);
    assert.equal(Object.hasOwn(payload, "token"), false);
    assert.equal(delivery.secret_kind, "verify_email");
    assert.ok(delivery.secret_expires_at);
  }
});
