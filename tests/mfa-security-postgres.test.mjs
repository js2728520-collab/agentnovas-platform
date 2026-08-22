import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { encryptTotpSecret, getMfaRecoveryStatus, hashRecoveryCode, rotateMfaRecoveryCodes, totpCode, verifyAndConsumeMfa } from "../lib/mfa.ts";

const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `mfa_test_${process.pid}_${Date.now()}`;
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
  `);
  await pool.query(`
    INSERT INTO user_mfa_totp_credentials (user_id, encrypted_secret, status, enabled_at)
      VALUES ('admin', $1, 'active', now())
  `, [await encryptTotpSecret("JBSWY3DPEHPK3PXP", environment)]);
  await pool.query(`
    INSERT INTO user_mfa_recovery_codes (id, user_id, code_hash)
    VALUES ('recovery-1', 'admin', $1)
  `, [await hashRecoveryCode("ABCDE-FGHIJ-KLMNOP")]);
});

test("a recovery code is stored as a hash and can be consumed only once", async () => {
  const first = await verifyAndConsumeMfa(pool, { userId: "admin", code: "abcde-fghij-klmnop", environment });
  const replay = await verifyAndConsumeMfa(pool, { userId: "admin", code: "ABCDE-FGHIJ-KLMNOP", environment });
  assert.deepEqual(first, { ok: true, level: "recovery" });
  assert.deepEqual(replay, { ok: false, code: "INVALID_OR_REPLAYED" });
});

test("recovery rotation invalidates unused codes and records only hashes", async () => {
  const before = await getMfaRecoveryStatus(pool, { userId: "admin" });
  const rotated = await rotateMfaRecoveryCodes(pool, {
    userId: "admin",
    sessionId: "security-session",
    audience: "maintenance",
    reason: "定期轮换恢复凭证",
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.recoveryCodes.length, 8);
  assert.ok(rotated.recoveryCodes.every((code) => /^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/.test(code)));
  const old = await verifyAndConsumeMfa(pool, { userId: "admin", code: "ABCDE-FGHIJ-KLMNOP", environment });
  assert.deepEqual(old, { ok: false, code: "INVALID_OR_REPLAYED" });
  const after = await getMfaRecoveryStatus(pool, { userId: "admin" });
  assert.equal(before.enrolled, true);
  assert.equal(after.remainingRecoveryCodes, 8);
  const rawCodes = await pool.query("SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id='admin' AND used_at IS NULL");
  assert.ok(rawCodes.rows.every((row) => !rotated.recoveryCodes.includes(row.code_hash)));
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("the same TOTP counter is accepted at most once under concurrency", async () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const counter = Math.floor(now.getTime() / 1000 / 30);
  const code = await totpCode("JBSWY3DPEHPK3PXP", counter);
  const results = await Promise.all(Array.from({ length: 6 }, () => verifyAndConsumeMfa(pool, {
    userId: "admin", code, now, environment,
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.ok(results.filter((result) => !result.ok).every((result) => result.code === "INVALID_OR_REPLAYED"));
});
