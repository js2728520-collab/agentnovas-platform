import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { lockScopedRoleForTarget } from "../lib/access-role-authorization.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `access_role_target_${process.pid}_${Date.now()}`;
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
    INSERT INTO users (id, email, password_hash, role, status, organization_id) VALUES
      ('actor-a', 'actor-a@example.test', 'disabled', 'branch_admin', 'active', 'org-a'),
      ('target-a', 'target-a@example.test', 'disabled', 'employee', 'active', 'org-a'),
      ('target-b', 'target-b@example.test', 'disabled', 'employee', 'active', 'org-b');
    INSERT INTO roles
      (id, application_id, code, name, kind, created_organization_id, applies_to_organization_id, status)
    VALUES
      ('role-global', 'operations', 'target_global', 'Global', 'custom', NULL, NULL, 'published'),
      ('role-a', 'operations', 'target_a', 'A', 'custom', 'org-a', 'org-a', 'published'),
      ('role-b', 'operations', 'target_b', 'B', 'custom', 'org-b', 'org-b', 'published'),
      ('role-mixed', 'operations', 'target_mixed', 'Mixed', 'custom', 'org-a', 'org-b', 'published'),
      ('role-draft', 'operations', 'target_draft', 'Draft', 'custom', 'org-a', 'org-a', 'draft')
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

async function lock(roleId, scope = "ORGANIZATION_SET", organizationIds = ["org-a"], targetOrganizationId = "org-a") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await lockScopedRoleForTarget(client, {
      roleId,
      appId: "operations",
      targetOrganizationId,
      scope,
      actor: { id: "actor-a", organizationId: "org-a" },
      organizationIds,
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("role mutation guard matches the roles GET owner/applies-to visibility predicate", async () => {
  assert.equal((await lock("role-global"))?.id, "role-global");
  assert.equal((await lock("role-a"))?.id, "role-a");
  assert.equal(await lock("role-b"), null);
  assert.equal(await lock("role-mixed"), null);
  assert.equal(await lock("role-draft"), null);
});

test("even platform reviewers cannot apply an organization-specific role to another organization", async () => {
  assert.equal((await lock("role-a", "PLATFORM", [], "org-a"))?.id, "role-a");
  assert.equal(await lock("role-b", "PLATFORM", [], "org-a"), null);
});

test("assignment creation, change request, and approval all lock the canonical scoped role target", async () => {
  const sources = await Promise.all([
    "../app/api/access/assignments/route.internal.ts",
    "../app/api/access/change-requests/route.internal.ts",
    "../app/api/access/change-requests/[id]/decisions/route.internal.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.match(source, /lockScopedRoleForTarget/);
    assert.match(source, /await client\.query\("BEGIN"\)/);
  }
  assert.ok(sources[2].indexOf("lockScopedRoleForTarget") < sources[2].indexOf("applyApprovedChange"));
});
