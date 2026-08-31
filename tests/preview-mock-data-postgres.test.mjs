import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";
import { seedPreviewMockData, verifyPreviewMockData } from "../scripts/seed-preview-mock-data.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `preview_mock_${process.pid}_${Date.now()}`;
const adminPool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : null;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` }) : null;

test("preview MOCK seed is replayable on the full schema without changing provider configuration", {
  skip: !databaseUrl,
}, async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await runPostgresMigrations(pool, {
      directory: new URL("../postgres/migrations/", import.meta.url),
      commitSha: "preview-mock-data-test",
      migrationSchema: schema,
    });
    await pool.query(`
      INSERT INTO organizations(id,type,name,status)
      VALUES('test-hq','headquarters','Riverton Capital 总公司','active');
      INSERT INTO users(id,email,password_hash,role,organization_id,status,email_verified_at)
      VALUES
        ('test-admin','admin@fixture.invalid','not-used','hq_admin','test-hq','active',now()::text),
        ('test-client','client@fixture.invalid','not-used','customer',NULL,'active',now()::text),
        ('test-operations','operations@fixture.invalid','not-used','employee','test-hq','active',now()::text),
        ('test-maintenance','maintenance@fixture.invalid','not-used','employee','test-hq','active',now()::text);
      INSERT INTO roles(
        id,application_id,code,name,kind,created_organization_id,status,is_system,created_by_user_id
      ) VALUES
        ('test-role-client','client','acceptance_client_admin_v1','Client acceptance','custom','test-hq','published',false,'test-admin'),
        ('test-role-operations','operations','acceptance_operations_admin_v1','Operations acceptance','custom','test-hq','published',false,'test-admin'),
        ('test-role-maintenance','maintenance','acceptance_maintenance_admin_v1','Maintenance acceptance','custom','test-hq','published',false,'test-admin');
      INSERT INTO user_role_assignments(
        id,user_id,role_id,application_id,organization_id,status,granted_by_user_id,reason
      ) VALUES
        ('test-assignment-client','test-client','test-role-client','client',NULL,'active','test-admin','test fixture'),
        ('test-assignment-operations','test-operations','test-role-operations','operations','test-hq','active','test-admin','test fixture'),
        ('test-assignment-maintenance','test-maintenance','test-role-maintenance','maintenance','test-hq','active','test-admin','test fixture');
    `);
    const providerBefore = (await pool.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(provider) ORDER BY provider.id),'[]'::jsonb)::text AS snapshot
      FROM payment_provider_configs provider
    `)).rows[0].snapshot;
    const now = new Date("2026-08-31T08:00:00.000Z");
    const first = await seedPreviewMockData(pool, { now, passwordHash: "not-used-mock-password-hash" });
    const second = await seedPreviewMockData(pool, { now, passwordHash: "not-used-mock-password-hash" });
    const verified = await verifyPreviewMockData(pool);
    assert.deepEqual(second, first);
    assert.deepEqual(verified, first);
    assert.equal(first.counts.synthetic_users, 16);
    assert.equal(first.counts.paper_portfolios, 9);
    assert.equal(first.counts.paper_fills, 4);
    assert.equal(first.counts.runnable_deployments, 0);
    assert.equal(first.counts.unsafe_notifications, 0);
    assert.equal(first.counts.unbalanced_ledger_transactions, 0);
    const providerAfter = (await pool.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(provider) ORDER BY provider.id),'[]'::jsonb)::text AS snapshot
      FROM payment_provider_configs provider
    `)).rows[0].snapshot;
    assert.equal(providerAfter, providerBefore);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM notification_deliveries
      WHERE id LIKE 'mock-v1%' AND channel<>'in_app'
    `)).rows[0].count, 0);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
});
