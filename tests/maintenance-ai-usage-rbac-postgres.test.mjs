import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `maintenance_ai_usage_rbac_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
let migrationDirectory;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-ai-usage-rbac-"));
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) >= 74) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "before-ai-usage-rbac-repair",
  });

  await pool.query(`
    INSERT INTO organizations(id,type,name,status)
    VALUES ('org-tech','branch','技术分公司','active');
    INSERT INTO users(id,email,password_hash,role,organization_id,status)
    VALUES
      ('legacy-technician','legacy-technician@example.test','disabled','tech_staff','org-tech','active'),
      ('revoked-technician','revoked-technician@example.test','disabled','tech_staff','org-tech','active');

    INSERT INTO roles(id,application_id,code,name,kind,status,is_system)
    VALUES
      ('legacy-wrong-operations-role','operations','maint_technical','旧版错误技术角色','system','published',true),
      ('existing-maintenance-role','maintenance','maint_technical','旧版运维技术角色','system','published',true);
    INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
    VALUES (
      'legacy-overprivileged-permission',
      'existing-maintenance-role',
      'maint.releases.approve',
      'PLATFORM',
      '[]'::jsonb
    );
    INSERT INTO user_role_assignments(
      id,user_id,role_id,application_id,organization_id,
      scope_organization_ids_json,status,effective_at,reason
    ) VALUES (
      'legacy-wrong-operations-assignment',
      'legacy-technician',
      'legacy-wrong-operations-role',
      'operations',
      'org-tech',
      '["org-tech"]'::jsonb,
      'active',
      now(),
      'legacy provisioning bug'
    );
    INSERT INTO rbac_revocation_tombstones(
      id,user_id,application_id,revoked_assignment_id,revoked_role_id,reason
    ) VALUES (
      'revoked-technician-maintenance-tombstone',
      'revoked-technician',
      'maintenance',
      NULL,
      'existing-maintenance-role',
      'explicitly revoked before migration 0074'
    );
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("migration repairs existing technical users into the least-privilege Maintenance role idempotently", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0074_maintenance_ai_usage_analytics.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);

  const assignments = (await pool.query(`
    SELECT assignment.application_id,assignment.status,role.code
    FROM user_role_assignments AS assignment
    JOIN roles AS role ON role.id=assignment.role_id
    WHERE assignment.user_id='legacy-technician'
    ORDER BY assignment.application_id,assignment.status
  `)).rows;
  assert.deepEqual(assignments, [
    { application_id: "maintenance", status: "active", code: "maint_technical" },
    { application_id: "operations", status: "revoked", code: "maint_technical" },
  ]);

  const permissions = (await pool.query(`
    SELECT permission.permission_key
    FROM roles AS role
    JOIN role_permissions AS permission ON permission.role_id=role.id
    WHERE role.application_id='maintenance' AND role.code='maint_technical'
    ORDER BY permission.permission_key
  `)).rows.map((row) => row.permission_key);
  assert.equal(permissions.length, 14);
  assert.ok(permissions.includes("maint.ai_usage.view"));
  assert.equal(permissions.includes("maint.releases.approve"), false);
  assert.equal(new Set(permissions).size, permissions.length);
});

test("migration does not restore Maintenance access for a technical user with an application revocation tombstone", async () => {
  const assignments = (await pool.query(`
    SELECT assignment.id
    FROM user_role_assignments AS assignment
    WHERE assignment.user_id='revoked-technician'
      AND assignment.application_id='maintenance'
      AND assignment.status IN ('active','pending')
  `)).rows;
  assert.deepEqual(assignments, []);

  const tombstone = (await pool.query(`
    SELECT reason
    FROM rbac_revocation_tombstones
    WHERE user_id='revoked-technician' AND application_id='maintenance'
  `)).rows;
  assert.deepEqual(tombstone, [{ reason: "explicitly revoked before migration 0074" }]);
});
