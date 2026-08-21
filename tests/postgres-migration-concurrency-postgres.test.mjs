import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `migration_concurrency_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-migration-concurrency-"));
const connection = {
  connectionString: databaseUrl,
  max: 1,
  options: `-c search_path=${schema}`,
};
const firstPool = new pg.Pool(connection);
const secondPool = new pg.Pool(connection);

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await writeFile(join(migrationDirectory, "0000_lock_probe.sql"), `
    SELECT pg_sleep(0.15);
    CREATE TABLE migration_lock_probe(id integer PRIMARY KEY);
  `);
});

test.after(async () => {
  await Promise.all([firstPool.end(), secondPool.end()]);
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("concurrent migration runners serialize and record one application", async () => {
  const directory = new URL("./", pathToFileURL(join(migrationDirectory, "placeholder")));
  const [first, second] = await Promise.all([
    runPostgresMigrations(firstPool, { directory, commitSha: "concurrency-proof-a" }),
    runPostgresMigrations(secondPool, { directory, commitSha: "concurrency-proof-b" }),
  ]);

  assert.deepEqual([first.applied.length, second.applied.length].sort(), [0, 1]);
  assert.deepEqual([first.skipped.length, second.skipped.length].sort(), [0, 1]);
  const registry = await adminPool.query(`
    SELECT name, checksum, commit_sha
    FROM "${schema}"."_agentnovas_migrations"
  `);
  assert.equal(registry.rowCount, 1);
  assert.equal(registry.rows[0].name, "0000_lock_probe.sql");
  assert.match(registry.rows[0].checksum, /^[a-f0-9]{64}$/);
  assert.ok(["concurrency-proof-a", "concurrency-proof-b"].includes(registry.rows[0].commit_sha));
});
