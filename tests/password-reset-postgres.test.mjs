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
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO organizations (id, type, name) VALUES ('org', 'headquarters', 'HQ');
    INSERT INTO users (id, email, password_hash, role, organization_id, status)
      VALUES ('pending-user', 'pending@example.test', 'disabled', 'employee', 'org', 'pending');
    INSERT INTO roles (id, application_id, code, name, kind, status)
      VALUES ('role-1', 'operations', 'ops_invited_employee', 'Employee', 'system', 'published');
    INSERT INTO user_role_assignments (id, user_id, role_id, application_id, organization_id, scope_organization_ids_json, effective_at)
      VALUES ('assignment-1', 'pending-user', 'role-1', 'operations', 'org', '["org"]'::jsonb, '2026-08-20T00:00:00.000Z');
    INSERT INTO auth_tokens (id, user_id, token_hash, purpose, token_audience, expires_at)
      VALUES
        ('token-1', 'pending-user', 'token-hash', 'reset_password', 'operations', '2026-08-20T02:00:00.000Z'),
        ('token-2', 'pending-user', 'token-hash-sibling', 'reset_password', 'operations', '2026-08-20T02:00:00.000Z');
    INSERT INTO sessions (id, user_id, token_hash, app_audience, expires_at, idle_expires_at, absolute_expires_at)
      VALUES ('session-1', 'pending-user', 'session-hash', 'operations', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
  `);
});
test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("a password reset token activates and mutates an account at most once", async () => {
  assert.deepEqual(await consumePasswordReset(pool, {
    tokenHash: "token-hash",
    passwordHash: "wrong-audience-hash",
    audience: "client",
    now: new Date("2026-08-20T01:00:00.000Z"),
  }), { ok: false, code: "INVALID_OR_EXPIRED" });
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => consumePasswordReset(pool, {
    tokenHash: "token-hash",
    passwordHash: `new-hash-${index}`,
    audience: "operations",
    primarySession: {
      id: `primary-${index}`,
      tokenHash: `primary-hash-${index}`,
      expiresAt: "2026-08-20T13:00:00.000Z",
      idleExpiresAt: "2026-08-20T01:10:00.000Z",
      absoluteExpiresAt: "2026-08-20T13:00:00.000Z",
      ipAddress: "127.0.0.1",
      userAgent: "test",
    },
    now: new Date("2026-08-20T01:00:00.000Z"),
  })));
  assert.equal(attempts.filter((result) => result.ok).length, 1);
  assert.deepEqual(attempts.find((result) => result.ok), {
    ok: true,
    accountActivated: true,
    primarySessionCreated: true,
    mfaEnrollmentRequired: true,
  });
  const user = (await pool.query(`SELECT status, email_verified_at FROM users WHERE id = 'pending-user'`)).rows[0];
  assert.equal(user.status, "active");
  assert.ok(user.email_verified_at);
  const session = (await pool.query(`SELECT revoked_at FROM sessions WHERE id = 'session-1'`)).rows[0];
  assert.ok(session.revoked_at);
  const primary = await pool.query(`SELECT mfa_level, revoked_at FROM sessions WHERE id LIKE 'primary-%'`);
  assert.equal(primary.rowCount, 1);
  assert.equal(primary.rows[0].mfa_level, "primary");
  assert.equal(primary.rows[0].revoked_at, null);
});

test("concurrent sibling invitation reset tokens allow only one password mutation", async () => {
  await pool.query(`
    UPDATE auth_tokens SET used_at = NULL WHERE user_id = 'pending-user';
    UPDATE users SET status = 'pending', password_hash = 'disabled' WHERE id = 'pending-user';
    DELETE FROM sessions WHERE user_id = 'pending-user';
  `);
  const attempts = await Promise.all([
    ["token-hash", "sibling-password-one", "sibling-primary-one"],
    ["token-hash-sibling", "sibling-password-two", "sibling-primary-two"],
  ].map(([tokenHash, passwordHash, sessionId]) => consumePasswordReset(pool, {
    tokenHash,
    passwordHash,
    audience: "operations",
    primarySession: {
      id: sessionId,
      tokenHash: `${sessionId}-hash`,
      expiresAt: "2026-08-20T13:00:00.000Z",
      idleExpiresAt: "2026-08-20T01:10:00.000Z",
      absoluteExpiresAt: "2026-08-20T13:00:00.000Z",
      ipAddress: "127.0.0.1",
      userAgent: "test",
    },
    now: new Date("2026-08-20T01:00:00.000Z"),
  })));
  assert.equal(attempts.filter((result) => result.ok).length, 1);
  assert.equal(attempts.filter((result) => !result.ok && result.code === "INVALID_OR_EXPIRED").length, 1);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM auth_tokens
    WHERE user_id = 'pending-user' AND purpose = 'reset_password' AND used_at IS NULL
  `)).rows[0].count, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM sessions
    WHERE user_id = 'pending-user' AND revoked_at IS NULL
  `)).rows[0].count, 1);
});
