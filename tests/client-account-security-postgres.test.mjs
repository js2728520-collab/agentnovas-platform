import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `client_account_security_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` });

const migrationNames = [
  "0000_business_schema.sql",
  "0015_riverton_three_app_rbac_wallet.sql",
  "0021_identity_access_hardening.sql",
  "0040_client_identity_rls.sql",
  "0066_client_email_and_device_security.sql",
];

async function completeLogin({
  sessionId,
  tokenHash,
  deviceHash,
  networkKey,
  now = "2026-08-23T00:00:00.000Z",
}) {
  return (await pool.query(`
    SELECT * FROM client_complete_login_v3(
      'device-customer','password-hash',NULL,$1,$2,
      $3::timestamptz + interval '7 days','none',$3::timestamptz,
      $3::timestamptz + interval '1 day',$3::timestamptz + interval '7 days',
      '203.0.113.8','test browser',$4,$5
    )
  `, [sessionId, tokenHash, now, deviceHash, networkKey])).rows[0];
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of migrationNames) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO users(id,email,phone,password_hash,email_verified_at,role,status)
    VALUES('device-customer','device@example.test','+14158675309','password-hash',
      '2026-08-22T00:00:00.000Z','customer','active')
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("five distinct devices are allowed and a sixth is rejected without evicting an existing device", async () => {
  for (let index = 1; index <= 5; index += 1) {
    const result = await completeLogin({
      sessionId: `session-${index}`,
      tokenHash: String(index).repeat(64),
      deviceHash: String(index + 1).repeat(64),
      networkKey: `ipv4:203.0.${index}`,
    });
    assert.equal(result.completed, true);
    assert.equal(result.failure_code, null);
    assert.equal(result.active_devices, index);
  }

  const rejected = await completeLogin({
    sessionId: "session-6",
    tokenHash: "6".repeat(64),
    deviceHash: "7".repeat(64),
    networkKey: "ipv4:198.51.100",
  });
  assert.equal(rejected.completed, false);
  assert.equal(rejected.failure_code, "DEVICE_LIMIT_REACHED");
  assert.equal(rejected.active_devices, 5);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM sessions WHERE revoked_at IS NULL`)).rows[0].count, 5);
});

test("same-device login rotates its session and a network change is flagged", async () => {
  const result = await completeLogin({
    sessionId: "session-1-rotated",
    tokenHash: "a".repeat(64),
    deviceHash: "2".repeat(64),
    networkKey: "ipv4:198.51.100",
    now: "2026-08-23T00:05:00.000Z",
  });
  assert.equal(result.completed, true);
  assert.equal(result.new_device, false);
  assert.equal(result.unusual_network, true);
  assert.equal(result.active_devices, 5);
  assert.ok((await pool.query(`SELECT revoked_at FROM sessions WHERE id='session-1'`)).rows[0].revoked_at);
});

test("concurrent logins cannot race past the five-device limit", async () => {
  await pool.query(`UPDATE sessions SET revoked_at='2026-08-23T00:06:00.000Z'`);
  const tokenCharacters = ["c", "d", "e", "f"];
  for (let index = 1; index <= 4; index += 1) {
    await completeLogin({
      sessionId: `race-existing-${index}`,
      tokenHash: tokenCharacters[index - 1].repeat(64),
      deviceHash: String(index + 1).repeat(64),
      networkKey: `ipv4:192.0.2.${index}`,
      now: "2026-08-23T00:10:00.000Z",
    });
  }
  const attempts = await Promise.all([
    completeLogin({ sessionId: "race-a", tokenHash: "g".repeat(64), deviceHash: "a".repeat(64), networkKey: "ipv4:203.0.113", now: "2026-08-23T00:11:00.000Z" }),
    completeLogin({ sessionId: "race-b", tokenHash: "h".repeat(64), deviceHash: "b".repeat(64), networkKey: "ipv4:198.51.100", now: "2026-08-23T00:11:00.000Z" }),
  ]);
  assert.deepEqual(attempts.map((row) => row.completed).sort(), [false, true]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM sessions WHERE revoked_at IS NULL`)).rows[0].count, 5);
});

test("all-session revocation is session-bound and includes the current device", async () => {
  const active = (await pool.query(`SELECT token_hash FROM sessions WHERE revoked_at IS NULL ORDER BY id LIMIT 1`)).rows[0];
  const result = (await pool.query(
    `SELECT client_revoke_all_sessions($1,$2) AS revoked_count`,
    [active.token_hash, new Date("2026-08-23T00:12:00.000Z")],
  )).rows[0];
  assert.equal(result.revoked_count, 5);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM sessions WHERE revoked_at IS NULL`)).rows[0].count, 0);
});
