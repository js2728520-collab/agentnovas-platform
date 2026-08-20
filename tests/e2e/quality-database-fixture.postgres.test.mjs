import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "../../scripts/quality/quality-database-fixture.mjs";
import {
  assertSafeFixtureDatabaseUrl,
  postgresUrlForSchema,
  qualitySchemaName,
} from "../../scripts/quality/quality-policy.mjs";

const adminDatabaseUrl = assertSafeFixtureDatabaseUrl(
  process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres",
).toString();

test("quality database fixture is isolated, complete, secret-safe, and disposable", async () => {
  const schema = qualitySchemaName(`fixture_${process.pid}_${Date.now()}`);
  const outputDirectory = await mkdtemp(join(tmpdir(), "agentnovas-quality-fixture-"));
  const adminPool = new pg.Pool({ connectionString: adminDatabaseUrl, max: 1 });
  let prepared = false;
  try {
    const fixture = await prepareQualityDatabaseFixture({
      adminDatabaseUrl,
      schema,
      outputDirectory,
    });
    prepared = true;
    assert.deepEqual(Object.keys(fixture.identities).sort(), [
      "client",
      "maintenanceAdmin",
      "operationsChecker",
      "operationsMaker",
    ]);
    assert.equal(fixture.schema, schema);
    assert.equal(fixture.externalWritesEnabled, false);

    const runtime = JSON.parse(await readFile(join(outputDirectory, "runtime.json"), "utf8"));
    assert.equal(runtime.schema, schema);
    assert.equal(runtime.externalWritesEnabled, false);
    assert.ok(!JSON.stringify(runtime).includes("password_hash"));

    const pool = new pg.Pool({
      connectionString: postgresUrlForSchema(adminDatabaseUrl, schema).toString(),
      max: 1,
    });
    try {
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM users WHERE email LIKE '%@quality.invalid'")).rows[0].count), 4);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM sessions WHERE revoked_at IS NULL")).rows[0].count), 4);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM commercial_legal_document_versions WHERE status='active'")).rows[0].count), 7);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM user_role_assignments WHERE status='active'")).rows[0].count), 4);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM notification_provider_configs WHERE status <> 'disabled'")).rows[0].count), 0);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM platform_demo_accounts")).rows[0].count), 0);
    } finally {
      await pool.end();
    }
  } finally {
    if (prepared) await cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema });
    const stillExists = await adminPool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
    assert.equal(stillExists.rowCount, 0);
    await adminPool.end();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
