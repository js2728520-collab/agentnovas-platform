import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `migration_chain_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  options: `-c search_path=${schema}`,
});
let migrationDirectory;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-migrations-"));
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

async function copyMigrations(maximumVersion) {
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    const version = Number(name.slice(0, 4));
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || version > maximumVersion) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
}

test("the real runner upgrades 0028 to 0029 and reapplies without drift", async () => {
  await copyMigrations(28);
  const before = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "n-minus-one",
  });
  assert.equal(before.applied.at(-1), "0028_commercial_legal_content.sql");

  await copyMigrations(29);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "current",
  });
  assert.deepEqual(upgraded.applied, ["0029_beta_legacy_runtime_hard_close.sql"]);
  const table = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name='commercial_legal_document_versions'
        AND column_name='content_markdown'
    ) AS present
  `);
  assert.equal(table.rows[0].present, true);

  const rerun = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "current",
  });
  assert.equal(rerun.applied.length, 0);
  assert.equal(rerun.skipped.length, 30);
});
