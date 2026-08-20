import assert from "node:assert/strict";
import test from "node:test";

import {
  migrationChecksum,
  planPostgresMigrations,
} from "../scripts/postgres-migration-runner.mjs";

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
