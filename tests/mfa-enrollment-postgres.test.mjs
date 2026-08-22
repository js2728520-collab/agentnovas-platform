import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { confirmMfaEnrollment, startMfaEnrollment, totpCode, verifyAndConsumeMfa } from "../lib/mfa.ts";

const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `mfa_enrollment_${process.pid}_${Date.now()}`;
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
      VALUES ('admin', 'admin@example.test', 'hash', 'hq_admin', 'org', 'active');
    INSERT INTO roles (id, application_id, code, name, kind, status)
      VALUES ('role', 'operations', 'ops_test', 'Test', 'system', 'published');
    INSERT INTO user_role_assignments (id, user_id, role_id, application_id, organization_id, scope_organization_ids_json)
      VALUES ('assignment', 'admin', 'role', 'operations', 'org', '["org"]'::jsonb);
    INSERT INTO sessions (
      id, user_id, token_hash, app_audience, expires_at, mfa_level,
      last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      'primary', 'admin', 'token', 'operations', '2026-08-20T12:00:00.000Z', 'primary',
      '2026-08-20T00:00:00.000Z', '2026-08-20T00:10:00.000Z', '2026-08-20T12:00:00.000Z'
    )
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("pending TOTP enrollment confirms once, upgrades the primary session, and returns recovery codes once", async () => {
  const started = await startMfaEnrollment(pool, { userId: "admin", environment, now: new Date("2026-08-20T00:00:00.000Z") });
  assert.equal(started.ok, true);
  const now = new Date("2026-08-20T00:01:00.000Z");
  const code = await totpCode(started.secret, Math.floor(now.getTime() / 1000 / 30));
  const results = await Promise.all(Array.from({ length: 4 }, () => confirmMfaEnrollment(pool, {
    userId: "admin",
    sessionId: "primary",
    audience: "operations",
    code,
    idleExpiresAt: "2026-08-20T01:01:00.000Z",
    environment,
    now,
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  const success = results.find((result) => result.ok);
  assert.equal(success.recoveryCodes.length, 8);
  assert.equal(new Set(success.recoveryCodes).size, 8);
  const storedCodes = await pool.query("SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id = 'admin'");
  assert.equal(storedCodes.rowCount, 8);
  for (const recoveryCode of success.recoveryCodes) {
    assert.ok(storedCodes.rows.every((row) => row.code_hash !== recoveryCode));
  }
  const session = (await pool.query("SELECT mfa_level, mfa_verified_at FROM sessions WHERE id = 'primary'")).rows[0];
  assert.equal(session.mfa_level, "totp");
  assert.ok(session.mfa_verified_at);
  assert.deepEqual(await verifyAndConsumeMfa(pool, { userId: "admin", code, now, environment }), { ok: false, code: "INVALID_OR_REPLAYED" });
  assert.deepEqual(await startMfaEnrollment(pool, { userId: "admin", environment, now }), { ok: false, code: "ALREADY_ENROLLED" });
});
