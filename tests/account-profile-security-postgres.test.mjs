import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { updateAccountProfile } from "../lib/account-profile.ts";
import { hashPassword } from "../lib/auth.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `account_profile_security_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

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
    INSERT INTO users(id,email,phone,username,nickname,password_hash,role,status)
    VALUES('profile-user','profile@example.test','+14158675309','profile-user','Old name',$1,'customer','active')
  `, [await hashPassword("current-password-123")]);
  await pool.query(`
    INSERT INTO sessions(
      id,user_id,token_hash,app_audience,expires_at,mfa_level,
      idle_expires_at,absolute_expires_at
    ) VALUES
      ('profile-current','profile-user','profile-current-token','client','2026-08-30T00:00:00.000Z','none','2026-08-22T00:00:00.000Z','2026-08-30T00:00:00.000Z'),
      ('profile-other','profile-user','profile-other-token','client','2026-08-30T00:00:00.000Z','none','2026-08-22T00:00:00.000Z','2026-08-30T00:00:00.000Z')
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

const baseProfile = {
  username: "profile-user",
  nickname: "Updated name",
  avatarUrl: "",
  phone: "+14158675309",
  dateOfBirth: null,
  gender: "",
  timezone: "Asia/Shanghai",
};

test("non-login profile fields do not require a password or revoke sessions", async () => {
  assert.deepEqual(await updateAccountProfile(pool, {
    userId: "profile-user",
    currentSessionId: "profile-current",
    currentPassword: "",
    profile: baseProfile,
    now: new Date("2026-08-21T09:00:00.000Z"),
  }), { ok: true, loginIdentifiersChanged: [], otherSessionsRevoked: 0 });
  assert.equal((await pool.query(`SELECT nickname FROM users WHERE id='profile-user'`)).rows[0].nickname, "Updated name");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM sessions WHERE user_id='profile-user' AND revoked_at IS NULL`)).rows[0].count, 2);
});

test("login identifier changes require the current password and revoke only other sessions", async () => {
  const changedProfile = { ...baseProfile, username: "profile-user-2", phone: "+14158675310" };
  assert.deepEqual(await updateAccountProfile(pool, {
    userId: "profile-user",
    currentSessionId: "profile-current",
    currentPassword: "wrong-password",
    profile: changedProfile,
    now: new Date("2026-08-21T09:01:00.000Z"),
  }), { ok: false, code: "CURRENT_PASSWORD_INVALID" });
  assert.deepEqual((await pool.query(`SELECT username,phone FROM users WHERE id='profile-user'`)).rows[0], {
    username: "profile-user",
    phone: "+14158675309",
  });

  assert.deepEqual(await updateAccountProfile(pool, {
    userId: "profile-user",
    currentSessionId: "profile-current",
    currentPassword: "current-password-123",
    profile: changedProfile,
    now: new Date("2026-08-21T09:02:00.000Z"),
  }), { ok: true, loginIdentifiersChanged: ["username", "phone"], otherSessionsRevoked: 1 });
  assert.deepEqual((await pool.query(`SELECT username,phone FROM users WHERE id='profile-user'`)).rows[0], {
    username: "profile-user-2",
    phone: "+14158675310",
  });
  assert.equal((await pool.query(`SELECT revoked_at IS NULL AS active FROM sessions WHERE id='profile-current'`)).rows[0].active, true);
  assert.equal((await pool.query(`SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE id='profile-other'`)).rows[0].revoked, true);
  const audit = (await pool.query(`SELECT after_json::text FROM audit_logs WHERE action='account.login_identifiers_changed'`)).rows[0].after_json;
  assert.match(audit, /username/);
  assert.match(audit, /phone/);
  assert.doesNotMatch(audit, /14158675310/);
});
