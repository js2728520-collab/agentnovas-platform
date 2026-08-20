import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { queueForgotPasswordRequest } from "../lib/forgot-password.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `forgot_password_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const environment = { NOTIFICATION_TOKEN_ENCRYPTION_KEY: "test-notification-token-key-longer-than-thirty-two-characters" };

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`INSERT INTO users (id, email, password_hash, role, status) VALUES ('known', 'known@example.test', 'disabled', 'customer', 'active')`);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("known and unknown forgot requests execute the same atomic PG path and only known users enqueue", async () => {
  const known = await queueForgotPasswordRequest(pool, {
    email: "known@example.test",
    now: new Date("2026-08-20T00:00:00.000Z"),
    environment,
  });
  const unknown = await queueForgotPasswordRequest(pool, {
    email: "unknown@example.test",
    now: new Date("2026-08-20T00:00:00.000Z"),
    environment,
  });
  assert.deepEqual(known, { queued: true });
  assert.deepEqual(unknown, { queued: false });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM auth_tokens")).rows[0].count, 1);
  const deliveries = (await pool.query("SELECT payload_json, secret_kind, secret_expires_at FROM notification_deliveries")).rows;
  assert.equal(deliveries.length, 1);
  const payload = JSON.parse(deliveries[0].payload_json);
  assert.match(payload.encryptedToken, /^v1\./);
  assert.equal(payload.expiresAt, "2026-08-20T01:00:00.000Z");
  assert.equal(Object.hasOwn(payload, "token"), false);
  assert.equal(deliveries[0].secret_kind, "reset_password");
  assert.equal(deliveries[0].secret_expires_at.toISOString(), "2026-08-20T01:00:00.000Z");
});
