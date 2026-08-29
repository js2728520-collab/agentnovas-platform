import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `restricted_cicd_upgrade_${process.pid}_${Date.now()}`;
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
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-restricted-cicd-upgrade-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("T8.1b upgrades 0076 through 0077/0078 and reruns without drift", async () => {
  await copyMigrations(76);
  const before = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "restricted-cicd-n-minus-one",
  });
  assert.equal(before.applied.at(-1), "0076_maintenance_work_record_export.sql");

  await copyMigrations(77);
  const facts = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "restricted-cicd-facts",
  });
  assert.deepEqual(facts.applied, ["0077_restricted_cicd_facts.sql"]);
  assert.equal((await pool.query(`SELECT to_regclass('release_workflow_commands') IS NOT NULL AS present`)).rows[0].present, true);

  await copyMigrations(78);
  const hardened = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "restricted-cicd-trigger-hardening",
  });
  assert.deepEqual(hardened.applied, ["0078_harden_internal_registration_link_role_trigger.sql"]);
  const triggerFunction = await pool.query(`
    SELECT prosecdef AS security_definer
      FROM pg_proc
     WHERE oid='protect_internal_registration_link_role()'::regprocedure
  `);
  assert.deepEqual(triggerFunction.rows, [{ security_definer: true }]);

  const rerun = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "restricted-cicd-rerun",
  });
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 79);
});
