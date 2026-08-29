import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `user_preference_upgrade_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
let migrationDirectory;

async function copyMigrations(maximumVersion) {
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    const version = Number(name.slice(0, 4));
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || version > maximumVersion) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-user-preference-upgrade-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("0089 upgrades the real 0088 schema, backfills legacy Client locale, and remains rollback-compatible", async () => {
  await copyMigrations(88);
  const before = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "user-preference-n-minus-one",
  });
  assert.equal(before.applied.at(-1), "0088_client_session_listing_expiry.sql");

  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status,locale) VALUES
      ('legacy-customer','legacy@example.test','fixture-hash','customer','active','zh-TW'),
      ('legacy-operator','operator@example.test','fixture-hash','employee','active','en-US')
  `);

  await copyMigrations(89);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "user-preference-current",
  });
  assert.deepEqual(upgraded.applied, ["0089_user_app_preferences.sql"]);
  assert.deepEqual((await pool.query(`
    SELECT user_id,app_audience,locale,theme_mode,theme_palette
      FROM user_app_preferences ORDER BY user_id
  `)).rows, [{
    user_id: "legacy-customer",
    app_audience: "client",
    locale: "zh-TW",
    theme_mode: "system",
    theme_palette: "classic",
  }]);

  // 0089 is additive: a previous Web image can still use the pre-0089 user projection.
  assert.deepEqual((await pool.query(`
    SELECT id,role,status,locale FROM users ORDER BY id
  `)).rows, [
    { id: "legacy-customer", role: "customer", status: "active", locale: "zh-TW" },
    { id: "legacy-operator", role: "employee", status: "active", locale: "en-US" },
  ]);

  const rerun = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "user-preference-rerun",
  });
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 90);
});
