import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  migrationRegistrySha256,
  migrationChecksum,
  migrationSchemaSearchPath,
  planPostgresMigrations,
} from "../scripts/postgres-migration-runner.mjs";

test("uses an explicitly quoted application schema before pg_catalog", () => {
  assert.equal(migrationSchemaSearchPath("public"), '"public",pg_catalog');
  assert.equal(migrationSchemaSearchPath("release_2026"), '"release_2026",pg_catalog');
  assert.throws(() => migrationSchemaSearchPath("pg_catalog"), /unsafe PostgreSQL migration schema/i);
  assert.throws(() => migrationSchemaSearchPath("public,pg_catalog"), /unsafe PostgreSQL migration schema/i);
});

test("plans only unapplied PostgreSQL migrations in filename order", () => {
  const migrations = [
    { name: "0002_second.sql", sql: "SELECT 2;" },
    { name: "0001_first.sql", sql: "SELECT 1;" },
  ];
  const applied = new Map([
    ["0001_first.sql", { checksum: migrationChecksum("SELECT 1;") }],
  ]);

  assert.deepEqual(planPostgresMigrations(migrations, applied), {
    pending: [{
      name: "0002_second.sql",
      sql: "SELECT 2;",
      checksum: migrationChecksum("SELECT 2;"),
    }],
    skipped: ["0001_first.sql"],
  });
});

test("migration registry identity is order-independent and checksum-bound", () => {
  const first = { name: "0001_first.sql", sql: "SELECT 1;" };
  const second = { name: "0002_second.sql", sql: "SELECT 2;" };
  assert.equal(
    migrationRegistrySha256([second, first]),
    migrationRegistrySha256([first, second]),
  );
  assert.notEqual(
    migrationRegistrySha256([first, second]),
    migrationRegistrySha256([first, { ...second, sql: "SELECT 3;" }]),
  );
});

test("fails closed when an applied migration checksum changes", () => {
  const migrations = [{ name: "0001_first.sql", sql: "SELECT 1;" }];
  const applied = new Map([
    ["0001_first.sql", { checksum: migrationChecksum("SELECT 999;") }],
  ]);

  assert.throws(
    () => planPostgresMigrations(migrations, applied),
    /checksum mismatch for 0001_first\.sql/i,
  );
});

test("fails closed when a legacy migration record has no verifiable checksum", () => {
  const migrations = [{ name: "0001_first.sql", sql: "SELECT 1;" }];
  const applied = new Map([["0001_first.sql", { checksum: null }]]);

  assert.throws(
    () => planPostgresMigrations(migrations, applied),
    /legacy migration checksum missing for 0001_first\.sql/i,
  );
});

test("keeps the deployed 0066 migration checksum immutable", async () => {
  const sql = await readFile(
    new URL("../postgres/migrations/0066_client_email_and_device_security.sql", import.meta.url),
    "utf8",
  );

  assert.equal(
    migrationChecksum(sql),
    "234aa5d2fed20640cbaf172ca773109ecb2e923044c600e05b8fed0b3bd76a9a",
  );
});
