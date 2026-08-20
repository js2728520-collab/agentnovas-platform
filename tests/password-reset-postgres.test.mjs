import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { consumePasswordReset } from "../lib/password-reset.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `password_reset_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL("../postgres/migrations/0000_business_schema.sql", import.meta.url), "utf8"));
  await pool.query(`
    INSERT INTO organizations (id, type, name) VALUES ('org', 'headquarters', 'HQ');
    INSERT INTO users (id, email, password_hash, role, organization_id, status)
      VALUES ('pending-user', 'pending@example.test', 'disabled', 'employee', 'org', 'pending');
    INSERT INTO auth_tokens (id, user_id, token_hash, purpose, expires_at)
      VALUES ('token-1', 'pending-user', 'token-hash', 'reset_password', '2026-08-20T02:00:00.000Z');
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES ('session-1', 'pending-user', 'session-hash', '2026-08-21T00:00:00.000Z');
  `);
});
test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("a password reset token activates and mutates an account at most once", async () => {
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => consumePasswordReset(pool, {
    tokenHash: "token-hash",
    passwordHash: `new-hash-${index}`,
    now: new Date("2026-08-20T01:00:00.000Z"),
  })));
  assert.equal(attempts.filter((result) => result.ok).length, 1);
  assert.deepEqual(attempts.find((result) => result.ok), { ok: true, accountActivated: true });
  const user = (await pool.query(`SELECT status, email_verified_at FROM users WHERE id = 'pending-user'`)).rows[0];
  assert.equal(user.status, "active");
  assert.ok(user.email_verified_at);
  const session = (await pool.query(`SELECT revoked_at FROM sessions WHERE id = 'session-1'`)).rows[0];
  assert.ok(session.revoked_at);
});
