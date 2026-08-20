import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { bootstrapInternalAdmin } from "../lib/internal-bootstrap.ts";

const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `bootstrap_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
});
test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("concurrent bootstrap creates one internal admin and cannot be replayed", async () => {
  const attempts = await Promise.all(Array.from({ length: 4 }, () => bootstrapInternalAdmin(pool, {
    email: "first-admin@example.test",
    password: "long-test-bootstrap-password",
    environment,
  })));
  assert.equal(attempts.filter((result) => result.ok).length, 1);
  assert.ok(attempts.filter((result) => !result.ok).every((result) => result.code === "ALREADY_BOOTSTRAPPED"));
  const created = attempts.find((result) => result.ok);
  assert.equal(created.recoveryCodes.length, 8);
  assert.match(created.totpUri, /^otpauth:\/\/totp\//);

  const users = await pool.query(`SELECT id, password_hash FROM users WHERE role = 'hq_admin'`);
  assert.equal(users.rowCount, 1);
  assert.match(users.rows[0].password_hash, /^\$argon2id\$/);
  const assignments = await pool.query(`SELECT application_id FROM user_role_assignments WHERE user_id = $1 AND status = 'active' ORDER BY application_id`, [users.rows[0].id]);
  assert.deepEqual(assignments.rows.map((row) => row.application_id), ["maintenance", "operations"]);
  const recovery = await pool.query(`SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id = $1`, [users.rows[0].id]);
  assert.equal(recovery.rowCount, 8);
  assert.ok(recovery.rows.every((row) => /^[a-f0-9]{64}$/.test(row.code_hash)));
  assert.ok(recovery.rows.every((row) => !created.recoveryCodes.includes(row.code_hash)));
});
