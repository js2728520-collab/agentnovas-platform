import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { purgeExpiredNotificationSecrets } from "../lib/notification-email-worker.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `notification_cleanup_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0021_identity_access_hardening.sql",
  ]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`INSERT INTO users (id, email, password_hash, role, status)
    VALUES ('cleanup-user', 'cleanup@example.test', 'disabled', 'customer', 'active')`);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("secret metadata is typed and must match a supported secret template", async () => {
  const columns = (await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'notification_deliveries'
      AND column_name IN ('secret_kind', 'secret_expires_at')
    ORDER BY column_name
  `)).rows;
  assert.deepEqual(columns, [
    { column_name: "secret_expires_at", data_type: "timestamp with time zone" },
    { column_name: "secret_kind", data_type: "text" },
  ]);
  await assert.rejects(pool.query(`
    INSERT INTO notification_deliveries (
      id, user_id, channel, category, template_key, payload_json, scheduled_at,
      secret_kind, secret_expires_at
    ) VALUES (
      'mismatched-kind', 'cleanup-user', 'email', 'security', 'team_daily_brief', '{}', now()::text,
      'reset_password', now() + interval '1 hour'
    )
  `), /check constraint|violates/i);
});

test("retention cleanup never parses payload text and malformed rows do not block the batch", async () => {
  await pool.query(`
    INSERT INTO notification_deliveries (
      id, user_id, channel, category, template_key, payload_json, status, scheduled_at,
      secret_kind, secret_expires_at
    ) VALUES
      ('expired-malformed', 'cleanup-user', 'email', 'security', 'reset_password', '{not-json', 'queued', now()::text, 'reset_password', '2026-08-19T23:00:00Z'),
      ('expired-valid', 'cleanup-user', 'email', 'security', 'reset_password', '{"encryptedToken":"v1.test"}', 'queued', now()::text, 'reset_password', '2026-08-19T23:00:00Z'),
      ('terminal-future', 'cleanup-user', 'email', 'security', 'internal_account_invite', '{also-not-json', 'sent', now()::text, 'internal_account_invite', '2026-08-21T00:00:00Z'),
      ('future-malformed', 'cleanup-user', 'email', 'security', 'reset_password', '{still-not-json', 'queued', now()::text, 'reset_password', '2026-08-21T00:00:00Z')
  `);

  assert.equal(await purgeExpiredNotificationSecrets(pool, new Date("2026-08-20T00:00:00.000Z")), 3);
  const rows = (await pool.query(`
    SELECT id, payload_json, status, last_error, secret_kind, secret_expires_at
    FROM notification_deliveries
    ORDER BY id
  `)).rows;
  assert.deepEqual(rows.map((row) => ({
    id: row.id,
    payload: row.payload_json,
    status: row.status,
    error: row.last_error,
    kind: row.secret_kind,
    hasExpiry: row.secret_expires_at !== null,
  })), [
    { id: "expired-malformed", payload: "{}", status: "failed", error: "TOKEN_EXPIRED", kind: null, hasExpiry: false },
    { id: "expired-valid", payload: "{}", status: "failed", error: "TOKEN_EXPIRED", kind: null, hasExpiry: false },
    { id: "future-malformed", payload: "{still-not-json", status: "queued", error: null, kind: "reset_password", hasExpiry: true },
    { id: "terminal-future", payload: "{}", status: "sent", error: null, kind: null, hasExpiry: false },
  ]);
});
