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
      "clientSecurity",
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
    const clientStorage = JSON.parse(await readFile(runtime.identities.client.storageState, "utf8"));
    assert.ok(clientStorage.cookies.length >= 1);
    assert.ok(clientStorage.cookies.every((cookie) => cookie.domain === "agentnovas.com"));
    assert.ok(clientStorage.cookies.every((cookie) => cookie.secure === true));

    const pool = new pg.Pool({
      connectionString: postgresUrlForSchema(adminDatabaseUrl, schema).toString(),
      max: 1,
    });
    try {
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM users WHERE email LIKE '%@quality.invalid'")).rows[0].count), 5);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM sessions WHERE revoked_at IS NULL")).rows[0].count), 4);
      const clientSessions = await pool.query(`
        SELECT session.id,session.app_audience,session.mfa_level,session.created_at,session.last_seen_at,
               session.idle_expires_at,session.absolute_expires_at,session.ip_address,session.user_agent
          FROM sessions AS session
         WHERE session.user_id=$1
           AND session.revoked_at IS NULL
           AND session.absolute_expires_at::timestamptz>now()
         ORDER BY COALESCE(session.last_seen_at,session.created_at::timestamptz) DESC,session.id DESC
         LIMIT 50
      `, [fixture.identities.client.userId]);
      assert.equal(clientSessions.rowCount, 1);
      assert.equal(clientSessions.rows[0].mfa_level, "none");
      assert.doesNotThrow(() => new Date(clientSessions.rows[0].idle_expires_at).toISOString());
      assert.doesNotThrow(() => new Date(clientSessions.rows[0].absolute_expires_at).toISOString());
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM commercial_legal_document_versions WHERE status='active'")).rows[0].count), 7);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM commercial_legal_document_versions WHERE status='active' AND content_markdown IS NOT NULL AND content_locale='en'")).rows[0].count), 7);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM commercial_legal_acceptances WHERE user_id=$1", [fixture.identities.client.userId])).rows[0].count), 7);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM user_role_assignments WHERE status='active'")).rows[0].count), 5);
      const permissionKeys = async (userId) => (await pool.query(`
        SELECT rp.permission_key
        FROM user_role_assignments ura
        JOIN role_permissions rp ON rp.role_id=ura.role_id
        WHERE ura.user_id=$1 AND ura.status='active'
        ORDER BY rp.permission_key
      `, [userId])).rows.map((row) => row.permission_key);
      const makerPermissions = await permissionKeys(fixture.identities.operationsMaker.userId);
      for (const permission of ["ops.organization.view", "ops.deposits.view", "ops.ledger.view"]) {
        assert.ok(makerPermissions.includes(permission), `maker must have representative read permission ${permission}`);
      }
      for (const checkerOnly of [
        "ops.approvals.decide",
        "ops.credits.approve",
        "ops.membership_orders.approve",
        "ops.performance_fees.approve",
        "ops.performance_fees.payment_approve",
      ]) assert.ok(!makerPermissions.includes(checkerOnly), `maker must not inherit checker permission ${checkerOnly}`);
      const checkerPermissions = await permissionKeys(fixture.identities.operationsChecker.userId);
      assert.ok(checkerPermissions.includes("ops.approvals.decide"));
      assert.ok(checkerPermissions.includes("ops.membership_orders.approve"));
      assert.ok(!checkerPermissions.includes("ops.membership_orders.evidence"));
      assert.ok(!checkerPermissions.includes("ops.performance_fees.payment_evidence"));
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
