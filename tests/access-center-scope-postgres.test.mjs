import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { accessOrganizationResourcePredicate, accessUserScopePredicate } from "../lib/access-center-scope.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `access_center_scope_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO organizations (id, type, name) VALUES ('org-a', 'branch', 'A'), ('org-b', 'branch', 'B');
    INSERT INTO users (id, email, password_hash, role, status, organization_id, reports_to_user_id) VALUES
      ('root', 'root@example.test', 'disabled', 'branch_admin', 'active', 'org-a', NULL),
      ('manager', 'manager@example.test', 'disabled', 'manager', 'active', 'org-a', 'root'),
      ('employee', 'employee@example.test', 'disabled', 'employee', 'active', 'org-a', 'manager'),
      ('outsider', 'outsider@example.test', 'disabled', 'branch_admin', 'active', 'org-b', NULL)
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

async function visible(scope, organizationIds = []) {
  const predicate = accessUserScopePredicate({
    scope,
    actor: { id: "root", organizationId: "org-a" },
    organizationIds,
    userAlias: "target_user",
    startIndex: 1,
  });
  const result = await pool.query(`SELECT target_user.id FROM users AS target_user WHERE ${predicate.clause} ORDER BY target_user.id`, predicate.values);
  return result.rows.map((row) => row.id);
}

test("Postgres Access Center predicate filters organization, direct-report, and team-tree grants", async () => {
  assert.deepEqual(await visible("ORGANIZATION_SET", ["org-a"]), ["employee", "manager", "root"]);
  assert.deepEqual(await visible("DIRECT_REPORTS"), ["manager", "root"]);
  assert.deepEqual(await visible("TEAM_TREE"), ["employee", "manager", "root"]);
  assert.deepEqual(await visible("SELF"), ["root"]);
  assert.deepEqual(await visible("PLATFORM"), ["employee", "manager", "outsider", "root"]);
});

test("Postgres Access Center predicate hides roles if owner or applies-to organization crosses the grant", async () => {
  await pool.query(`
    INSERT INTO roles
      (id, application_id, code, name, kind, created_organization_id, applies_to_organization_id, status)
    VALUES
      ('role-global', 'operations', 'scope_global', 'Global', 'custom', NULL, NULL, 'published'),
      ('role-a', 'operations', 'scope_a', 'A', 'custom', 'org-a', 'org-a', 'published'),
      ('role-b', 'operations', 'scope_b', 'B', 'custom', 'org-b', 'org-b', 'published'),
      ('role-mixed', 'operations', 'scope_mixed', 'Mixed', 'custom', 'org-a', 'org-b', 'published')
  `);
  const predicate = accessOrganizationResourcePredicate({
    scope: "ORGANIZATION_SET",
    actor: { id: "root", organizationId: "org-a" },
    organizationIds: ["org-a"],
    columns: ["r.created_organization_id", "r.applies_to_organization_id"],
    startIndex: 1,
  });
  const result = await pool.query(`SELECT r.id FROM roles AS r WHERE ${predicate.clause} ORDER BY r.id`, predicate.values);
  assert.deepEqual(result.rows.map((row) => row.id), ["role-a", "role-global"]);
});
