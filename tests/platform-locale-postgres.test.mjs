import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { supportedPlatformLocales } from "../lib/platform-locale.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `platform_locale_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
let migration;
let schemaCreated = false;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migration = await readFile(new URL("../postgres/migrations/0073_platform_locale_default.sql", import.meta.url), "utf8");
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await pool.query("CREATE TABLE users(id text PRIMARY KEY, locale text NOT NULL DEFAULT 'zh-CN')");
  await pool.query("INSERT INTO users(id,locale) VALUES('legacy-unknown','legacy-custom'),('legacy-chinese','zh-CN')");
});

test.after(async () => {
  await pool.end();
  if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("locale migration defaults new accounts to English without rewriting historical users", async () => {
  await pool.query(migration);

  const historical = await pool.query("SELECT id,locale FROM users WHERE id LIKE 'legacy-%' ORDER BY id");
  assert.deepEqual(historical.rows, [
    { id: "legacy-chinese", locale: "zh-CN" },
    { id: "legacy-unknown", locale: "legacy-custom" },
  ]);

  await pool.query("INSERT INTO users(id) VALUES('new-default')");
  assert.equal((await pool.query("SELECT locale FROM users WHERE id='new-default'")).rows[0].locale, "en-US");

  for (const [index, locale] of supportedPlatformLocales.entries()) {
    await pool.query("INSERT INTO users(id,locale) VALUES($1,$2)", [`supported-${index}`, locale]);
  }
  await assert.rejects(
    pool.query("INSERT INTO users(id,locale) VALUES('unsupported','fr-FR')"),
    (error) => error?.code === "23514",
  );

  const constraint = await pool.query(`
    SELECT convalidated
      FROM pg_constraint
     WHERE conrelid='users'::regclass
       AND conname='users_locale_supported_check'
  `);
  assert.equal(constraint.rows[0].convalidated, false);

  await pool.query(migration);
  await pool.query("INSERT INTO users(id) VALUES('new-default-after-replay')");
  assert.equal(
    (await pool.query("SELECT locale FROM users WHERE id='new-default-after-replay'")).rows[0].locale,
    "en-US",
  );
  await assert.rejects(
    pool.query("UPDATE users SET locale='invalid' WHERE id='new-default-after-replay'"),
    (error) => error?.code === "23514",
  );
});
