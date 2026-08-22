import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { changeAccountPassword } from "../lib/account-password.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `account_password_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL("../postgres/migrations/0000_business_schema.sql", import.meta.url), "utf8"));
  await pool.query(`
    INSERT INTO users (id, email, password_hash, role, status)
      VALUES ('user', 'user@example.test', $1, 'customer', 'active')
  `, [await hashPassword("old-password-123")]);
  await pool.query(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES ('session-a', 'user', 'a', '2026-08-21T00:00:00.000Z'),
             ('session-b', 'user', 'b', '2026-08-21T00:00:00.000Z')
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("password change updates password, revokes every session, and audits in one transaction", async () => {
  assert.deepEqual(await changeAccountPassword(pool, {
    userId: "user",
    currentPassword: "wrong-password",
    newPassword: "new-password-456",
    now: new Date("2026-08-20T00:00:00.000Z"),
  }), { ok: false, code: "CURRENT_PASSWORD_INVALID" });
  assert.deepEqual(await changeAccountPassword(pool, {
    userId: "user",
    currentPassword: "old-password-123",
    newPassword: "new-password-456",
    now: new Date("2026-08-20T00:01:00.000Z"),
  }), { ok: true });
  const user = (await pool.query("SELECT password_hash FROM users WHERE id = 'user'")).rows[0];
  assert.equal(await verifyPassword("new-password-456", user.password_hash), true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sessions WHERE user_id = 'user' AND revoked_at IS NULL")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE actor_user_id = 'user' AND action = 'auth.password_changed'")).rows[0].count, 1);
});
