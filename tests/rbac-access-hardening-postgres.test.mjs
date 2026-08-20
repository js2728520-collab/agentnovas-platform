import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { loadEffectiveAccess } from "../lib/effective-access.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `rbac_hardening_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0021_identity_access_hardening.sql",
  ]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO organizations (id, type, name) VALUES
      ('org-a', 'branch', 'A'), ('org-b', 'branch', 'B');
    INSERT INTO users (id, email, password_hash, role, organization_id, status)
      VALUES ('user-1', 'user-1@example.test', 'hash', 'hq_admin', 'org-a', 'active');
    INSERT INTO roles (id, application_id, code, name, kind, status)
      VALUES ('role-1', 'operations', 'ops-test', 'Test', 'custom', 'published');
    INSERT INTO role_permissions
      (id, role_id, permission_key, scope, scope_organization_ids_json)
      VALUES ('role-permission-1', 'role-1', 'ops.deposits.view', 'ORGANIZATION_SET', '["org-a", "org-b"]');
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("PostgreSQL effective access requires explicit internal assignments and honors tombstones", async () => {
  const user = { id: "user-1", role: "hq_admin" };
  assert.deepEqual(await loadEffectiveAccess(pool, user, "operations"), {
    source: "rbac",
    permissions: {},
    grants: {},
  });

  await pool.query(`
    INSERT INTO user_role_assignments
      (id, user_id, role_id, application_id, organization_id, scope_organization_ids_json)
    VALUES ('assignment-1', 'user-1', 'role-1', 'operations', 'org-a', '["org-a"]')
  `);
  const assigned = await loadEffectiveAccess(pool, user, "operations");
  assert.deepEqual(assigned.grants["ops.deposits.view"], {
    scope: "ORGANIZATION_SET",
    organizationIds: ["org-a"],
  });

  await pool.query(`
    UPDATE user_role_assignments
    SET status = 'revoked', revoked_at = now()
    WHERE id = 'assignment-1';
    INSERT INTO rbac_revocation_tombstones
      (id, user_id, application_id, revoked_assignment_id, revoked_role_id, reason)
    VALUES ('tombstone-1', 'user-1', 'operations', 'assignment-1', 'role-1', 'test revoke')
  `);
  assert.deepEqual(await loadEffectiveAccess(pool, user, "operations"), {
    source: "rbac",
    permissions: {},
    grants: {},
  });
});
