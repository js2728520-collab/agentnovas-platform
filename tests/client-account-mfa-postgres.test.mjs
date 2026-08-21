import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  confirmMfaEnrollment,
  getMfaRecoveryStatus,
  rotateMfaRecoveryCodes,
  startMfaEnrollment,
  totpCode,
  verifyAndConsumeMfa,
} from "../lib/mfa.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `client_mfa_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationNames = (await readdir(new URL("../postgres/migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 21)
    .sort();
  for (const name of migrationNames) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${name}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status)
    VALUES('client-user','client@example.test','unused','customer','active');
    INSERT INTO sessions(
      id,user_id,token_hash,app_audience,expires_at,mfa_level,
      idle_expires_at,absolute_expires_at
    ) VALUES(
      'client-session','client-user','client-token','client',
      '2026-08-30T00:00:00.000Z','primary',
      '2026-08-22T00:00:00.000Z','2026-08-30T00:00:00.000Z'
    );
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("Client enrollment and verified recovery rotation never persist plaintext recovery codes", async () => {
  const now = new Date("2026-08-21T08:00:00.000Z");
  const started = await startMfaEnrollment(pool, { userId: "client-user", environment, now });
  assert.equal(started.ok, true);
  const code = await totpCode(started.secret, Math.floor(now.getTime() / 30_000));
  const confirmed = await confirmMfaEnrollment(pool, {
    userId: "client-user",
    sessionId: "client-session",
    audience: "client",
    code,
    idleExpiresAt: "2026-08-22T00:00:00.000Z",
    environment,
    now,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.recoveryCodes.length, 8);
  assert.deepEqual(await getMfaRecoveryStatus(pool, { userId: "client-user" }), {
    enrolled: true,
    enabledAt: now.toISOString(),
    remainingRecoveryCodes: 8,
    lastRotatedAt: now.toISOString(),
  });

  const rotated = await rotateMfaRecoveryCodes(pool, {
    userId: "client-user",
    sessionId: "client-session",
    audience: "client",
    reason: "Client self-service recovery code rotation",
    verificationCode: confirmed.recoveryCodes[0],
    environment,
    now: new Date("2026-08-21T08:01:00.000Z"),
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.recoveryCodes.length, 8);
  assert.deepEqual(await verifyAndConsumeMfa(pool, {
    userId: "client-user",
    code: confirmed.recoveryCodes[1],
    environment,
    now: new Date("2026-08-21T08:02:00.000Z"),
  }), { ok: false, code: "INVALID_OR_REPLAYED" });
  const totpRotationTime = new Date("2026-08-21T08:02:00.000Z");
  const totpRotationCode = await totpCode(started.secret, Math.floor(totpRotationTime.getTime() / 30_000));
  const rotatedWithTotp = await rotateMfaRecoveryCodes(pool, {
    userId: "client-user",
    sessionId: "client-session",
    audience: "client",
    reason: "Client self-service recovery code rotation",
    verificationCode: totpRotationCode,
    environment,
    now: totpRotationTime,
  });
  assert.equal(rotatedWithTotp.ok, true);
  assert.deepEqual(await verifyAndConsumeMfa(pool, {
    userId: "client-user",
    code: rotated.recoveryCodes[0],
    environment,
    now: new Date("2026-08-21T08:02:00.000Z"),
  }), { ok: false, code: "INVALID_OR_REPLAYED" });
  assert.deepEqual(await verifyAndConsumeMfa(pool, {
    userId: "client-user",
    code: rotatedWithTotp.recoveryCodes[0],
    environment,
    now: new Date("2026-08-21T08:03:00.000Z"),
  }), { ok: true, level: "recovery" });

  const stored = (await pool.query(`
    SELECT encrypted_secret,code_hash
      FROM user_mfa_totp_credentials
      JOIN user_mfa_recovery_codes USING(user_id)
     WHERE user_id='client-user'
  `)).rows;
  assert.ok(stored.every(({ encrypted_secret }) => !encrypted_secret.includes(started.secret)));
  assert.ok(stored.every(({ code_hash }) => /^[a-f0-9]{64}$/.test(code_hash)));
  assert.ok(stored.every(({ code_hash }) => !rotatedWithTotp.recoveryCodes.includes(code_hash)));
});
