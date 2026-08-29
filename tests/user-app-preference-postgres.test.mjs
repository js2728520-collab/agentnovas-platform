import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `user_app_preference_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
let schemaCreated = false;
let migration;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migration = await readFile(new URL("../postgres/migrations/0089_user_app_preferences.sql", import.meta.url), "utf8");
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await pool.query(`
    CREATE TABLE users(
      id text PRIMARY KEY,
      role text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      locale text NOT NULL DEFAULT 'en-US'
    );
    CREATE TABLE sessions(
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      token_hash text NOT NULL UNIQUE,
      app_audience text NOT NULL,
      expires_at text NOT NULL,
      idle_expires_at timestamptz NOT NULL,
      absolute_expires_at timestamptz NOT NULL,
      revoked_at text
    );
  `);
});

test.after(async () => {
  await pool.end();
  if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("migration backfills only Client preferences and enforces six theme/locale combinations", async () => {
  await pool.query(`
    INSERT INTO users(id,role,locale) VALUES
      ('customer','customer','ja-JP'),
      ('operator','employee','en-US');
  `);
  await pool.query(migration);

  assert.deepEqual((await pool.query(`
    SELECT user_id,app_audience,locale,theme_mode,theme_palette
      FROM user_app_preferences ORDER BY user_id
  `)).rows, [{
    user_id: "customer", app_audience: "client", locale: "ja-JP",
    theme_mode: "system", theme_palette: "classic",
  }]);

  await assert.rejects(
    pool.query("INSERT INTO user_app_preferences(user_id,app_audience,locale) VALUES('operator','operations','ja-JP')"),
    (error) => error?.code === "23514",
  );
  await pool.query("INSERT INTO user_app_preferences(user_id,app_audience,locale,theme_mode,theme_palette) VALUES('operator','operations','zh-CN','dark','forest')");
  await assert.rejects(
    pool.query("UPDATE user_app_preferences SET theme_palette='rainbow' WHERE user_id='operator'"),
    (error) => error?.code === "23514",
  );
});

test("session-bound gateways derive the audience and fail closed for expired or revoked sessions", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const customerToken = digest("customer-token");
  const operatorToken = digest("operator-token");
  const maintenanceToken = digest("maintenance-token");
  const expiredToken = digest("expired-token");
  await pool.query(`
    INSERT INTO sessions(id,user_id,token_hash,app_audience,expires_at,idle_expires_at,absolute_expires_at)
    VALUES
      ('customer-session','customer',$1,'client',$5::text,$5::timestamptz,$5::timestamptz),
      ('operator-session','operator',$2,'operations',$5::text,$5::timestamptz,$5::timestamptz),
      ('maintenance-session','operator',$3,'maintenance',$5::text,$5::timestamptz,$5::timestamptz),
      ('expired-session','operator',$4,'maintenance',$6::text,$6::timestamptz,$6::timestamptz)
  `, [customerToken, operatorToken, maintenanceToken, expiredToken, future, past]);

  const clientPreference = (await pool.query("SELECT * FROM user_app_preference_read($1,$2)", [customerToken, new Date()])).rows[0];
  assert.equal(clientPreference.app_audience, "client");
  assert.equal(clientPreference.locale, "ja-JP");

  const updated = (await pool.query(
    "SELECT * FROM user_app_preference_upsert($1,$2,$3,$4,$5)",
    [operatorToken, "en-US", "light", "harbor", new Date()],
  )).rows[0];
  assert.equal(updated.app_audience, "operations");
  assert.equal(updated.locale, "en-US");
  assert.equal(updated.theme_mode, "light");
  assert.equal(updated.theme_palette, "harbor");
  await pool.query(
    "SELECT * FROM user_app_preference_upsert($1,$2,$3,$4,$5)",
    [maintenanceToken, "zh-CN", "dark", "forest", new Date()],
  );
  assert.deepEqual((await pool.query(`
    SELECT app_audience,locale,theme_mode,theme_palette
      FROM user_app_preferences WHERE user_id='operator' ORDER BY app_audience
  `)).rows, [
    { app_audience: "maintenance", locale: "zh-CN", theme_mode: "dark", theme_palette: "forest" },
    { app_audience: "operations", locale: "en-US", theme_mode: "light", theme_palette: "harbor" },
  ]);

  assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_app_preference_read($1,$2)", [expiredToken, new Date()])).rows[0].count, 0);
  await pool.query("UPDATE sessions SET revoked_at=now()::text WHERE id='operator-session'");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_app_preference_read($1,$2)", [operatorToken, new Date()])).rows[0].count, 0);
  await assert.rejects(
    pool.query("SELECT * FROM user_app_preference_upsert($1,$2,$3,$4,$5)", [operatorToken, "zh-CN", "system", "classic", new Date()]),
    /PREFERENCE_SESSION_INVALID/,
  );
});

test("preference migration is replay-safe", async () => {
  await pool.query(migration);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_app_preferences WHERE user_id='customer' AND app_audience='client'")).rows[0].count, 1);
});
