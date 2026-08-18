import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";
import pg from "pg";

import { migrateD1Database } from "../lib/d1-postgres-migration.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `d1_migration_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema}`,
});
let temporaryDirectory;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agentnovas-d1-migration-"));
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migration = await readFile(
    new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await pool.query(`
    DROP TABLE IF EXISTS z_missing;
    DROP TABLE IF EXISTS a_fixture;
    DROP TABLE IF EXISTS migration_fixture;
    TRUNCATE migration_batches CASCADE;
  `);
});

function sqliteFile(name, statements) {
  const path = join(temporaryDirectory, name);
  const database = new DatabaseSync(path);
  for (const statement of statements) database.exec(statement);
  database.close();
  return path;
}

test("imports every row, verifies count and SHA-256, and makes a repeated batch a no-op", async () => {
  const sourcePath = sqliteFile("success.sqlite", [
    "CREATE TABLE migration_fixture (id text PRIMARY KEY, amount real NOT NULL, enabled integer NOT NULL)",
    "INSERT INTO migration_fixture VALUES ('row-2', 12.5, 0), ('row-1', 8.25, 1)",
  ]);
  await pool.query(`
    CREATE TABLE migration_fixture (
      id text PRIMARY KEY,
      amount double precision NOT NULL,
      enabled integer NOT NULL
    )
  `);

  const first = await migrateD1Database({
    sqlitePath: sourcePath,
    database: pool,
    batchId: "batch-success",
    sourceRef: "d1-backup-success",
  });
  const repeated = await migrateD1Database({
    sqlitePath: sourcePath,
    database: pool,
    batchId: "batch-success",
    sourceRef: "d1-backup-success",
  });

  assert.equal(first.status, "verified");
  assert.equal(first.tables[0].sourceRowCount, 2);
  assert.equal(first.tables[0].targetRowCount, 2);
  assert.equal(first.tables[0].sourceSha256, first.tables[0].targetSha256);
  assert.deepEqual(repeated, first);
  const count = await pool.query("SELECT count(*)::int AS count FROM migration_fixture");
  assert.equal(count.rows[0].count, 2);
});

test("rolls back all copied rows and records a failed batch when any target table is missing", async () => {
  const sourcePath = sqliteFile("failure.sqlite", [
    "CREATE TABLE a_fixture (id text PRIMARY KEY, value text NOT NULL)",
    "INSERT INTO a_fixture VALUES ('one', 'copied-before-failure')",
    "CREATE TABLE z_missing (id text PRIMARY KEY)",
    "INSERT INTO z_missing VALUES ('missing')",
  ]);
  await pool.query("CREATE TABLE a_fixture (id text PRIMARY KEY, value text NOT NULL)");

  await assert.rejects(
    migrateD1Database({
      sqlitePath: sourcePath,
      database: pool,
      batchId: "batch-failure",
      sourceRef: "d1-backup-failure",
    }),
    /z_missing/,
  );

  const copied = await pool.query("SELECT count(*)::int AS count FROM a_fixture");
  const batch = await pool.query("SELECT status FROM migration_batches WHERE id = 'batch-failure'");
  assert.equal(copied.rows[0].count, 0);
  assert.equal(batch.rows[0].status, "failed");
});
