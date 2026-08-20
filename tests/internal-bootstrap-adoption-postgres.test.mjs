import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { verifyPassword } from "../lib/auth.ts";
import { bootstrapInternalAdmin } from "../lib/internal-bootstrap.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

async function withSchema(run) {
  const schema = `bootstrap_adopt_${process.pid}_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
      await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
    }
    return await run(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

test.after(async () => adminPool.end());

test("an explicitly matched active N-1 administrator can be adopted exactly once", async () => {
  await withSchema(async (pool) => {
    await pool.query(`
      INSERT INTO organizations (id, type, name) VALUES ('old-org', 'headquarters', 'Old HQ');
      INSERT INTO users (id, email, password_hash, role, organization_id, status, email_verified_at)
        VALUES ('old-admin', 'old-admin@example.test', 'disabled', 'hq_admin', 'old-org', 'active', now()::text);
      INSERT INTO sessions (id, user_id, token_hash, expires_at, app_audience)
        VALUES ('old-session', 'old-admin', 'old-token', '2099-01-01T00:00:00.000Z', 'operations');
    `);
    const adopted = await bootstrapInternalAdmin(pool, {
      email: "OLD-ADMIN@example.test",
      password: "new-secure-adopted-password",
      adoptLegacyAdmin: true,
      environment,
    });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.userId, "old-admin");
    const user = (await pool.query("SELECT password_hash FROM users WHERE id = 'old-admin'")).rows[0];
    assert.equal(await verifyPassword("new-secure-adopted-password", user.password_hash), true);
    assert.equal((await pool.query("SELECT 1 FROM user_mfa_totp_credentials WHERE user_id = 'old-admin' AND status = 'active'")).rowCount, 1);
    assert.deepEqual((await pool.query("SELECT application_id FROM user_role_assignments WHERE user_id = 'old-admin' AND status = 'active' ORDER BY application_id")).rows.map(row => row.application_id), ["maintenance", "operations"]);
    assert.ok((await pool.query("SELECT revoked_at FROM sessions WHERE id = 'old-session'")).rows[0].revoked_at);

    const replay = await bootstrapInternalAdmin(pool, {
      email: "old-admin@example.test",
      password: "another-secure-password",
      adoptLegacyAdmin: true,
      environment,
    });
    assert.deepEqual(replay, { ok: false, code: "ALREADY_BOOTSTRAPPED" });
  });
});

test("legacy adoption rejects pending, closed, mismatched, and ambiguous administrators", async () => {
  for (const scenario of [
    { users: [["candidate", "candidate@example.test", "pending"]], email: "candidate@example.test", code: "LEGACY_ADMIN_NOT_ACTIVE" },
    { users: [["candidate", "candidate@example.test", "closed"]], email: "candidate@example.test", code: "LEGACY_ADMIN_NOT_ACTIVE" },
    { users: [["candidate", "candidate@example.test", "active"]], email: "other@example.test", code: "LEGACY_ADMIN_EMAIL_MISMATCH" },
    { users: [["one", "one@example.test", "active"], ["two", "two@example.test", "active"]], email: "one@example.test", code: "LEGACY_ADMIN_AMBIGUOUS" },
  ]) {
    await withSchema(async (pool) => {
      await pool.query("INSERT INTO organizations (id, type, name) VALUES ('old-org', 'headquarters', 'Old HQ')");
      for (const [id, email, status] of scenario.users) {
        await pool.query("INSERT INTO users (id, email, password_hash, role, organization_id, status) VALUES ($1, $2, 'disabled', 'hq_admin', 'old-org', $3)", [id, email, status]);
      }
      const result = await bootstrapInternalAdmin(pool, {
        email: scenario.email,
        password: "new-secure-adopted-password",
        adoptLegacyAdmin: true,
        environment,
      });
      assert.deepEqual(result, { ok: false, code: scenario.code });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_mfa_totp_credentials")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_role_assignments")).rows[0].count, 0);
    });
  }
});

test("legacy adoption preserves a colliding custom role and creates stable collision-proof system identities", async () => {
  await withSchema(async (pool) => {
    await pool.query(`
      INSERT INTO organizations (id, type, name) VALUES ('old-org', 'headquarters', 'Old HQ');
      INSERT INTO users (id, email, password_hash, role, organization_id, status) VALUES
        ('old-admin', 'old-admin@example.test', 'disabled', 'hq_admin', 'old-org', 'active'),
        ('custom-assignee', 'assignee@example.test', 'disabled', 'employee', 'old-org', 'active');
      INSERT INTO roles (
        id, application_id, code, name, kind, created_organization_id,
        applies_to_organization_id, status, is_system, created_by_user_id
      ) VALUES (
        'custom-collision', 'operations', 'ops_bootstrap_admin', 'Existing custom role',
        'custom', 'old-org', 'old-org', 'published', false, 'custom-assignee'
      );
      INSERT INTO role_permissions (id, role_id, permission_key, scope)
        VALUES ('custom-permission', 'custom-collision', 'ops.customers.view', 'SELF');
      INSERT INTO user_role_assignments (
        id, user_id, role_id, application_id, organization_id, status, effective_at
      ) VALUES (
        'custom-assignment', 'custom-assignee', 'custom-collision', 'operations',
        'old-org', 'active', now()
      );
      INSERT INTO sessions (id, user_id, token_hash, expires_at, app_audience)
        VALUES ('collision-session', 'old-admin', 'collision-token', '2099-01-01T00:00:00.000Z', 'maintenance');
    `);

    const result = await bootstrapInternalAdmin(pool, {
      email: "old-admin@example.test",
      password: "new-secure-adopted-password",
      adoptLegacyAdmin: true,
      environment,
    });
    assert.equal(result.ok, true);
    assert.equal(result.adopted, true);
    assert.deepEqual((await pool.query(`
      SELECT kind, is_system, name FROM roles WHERE id = 'custom-collision'
    `)).rows[0], {
      kind: "custom",
      is_system: false,
      name: "Existing custom role",
    });
    assert.deepEqual((await pool.query(`
      SELECT permission_key, scope FROM role_permissions WHERE role_id = 'custom-collision'
    `)).rows, [{ permission_key: "ops.customers.view", scope: "SELF" }]);
    assert.equal((await pool.query(`
      SELECT 1 FROM user_role_assignments
      WHERE user_id = 'custom-assignee' AND role_id = 'custom-collision' AND status = 'active'
    `)).rowCount, 1);
    assert.equal((await pool.query(`
      SELECT 1 FROM user_mfa_totp_credentials WHERE user_id = 'old-admin' AND status = 'active'
    `)).rowCount, 1);
    assert.deepEqual((await pool.query(`
      SELECT identity.application_id, identity.system_key, role.id AS role_id, role.code
      FROM system_role_identities AS identity
      INNER JOIN roles AS role ON role.id = identity.role_id
      ORDER BY identity.application_id
    `)).rows.map((row) => ({
      applicationId: row.application_id,
      systemKey: row.system_key,
      roleId: row.role_id,
      reservedCode: /^__system_bootstrap_(operations|maintenance)_[0-9a-f]{32}$/.test(row.code),
    })), [
      { applicationId: "maintenance", systemKey: "bootstrap_admin", roleId: result.systemRoles.maintenance.roleId, reservedCode: true },
      { applicationId: "operations", systemKey: "bootstrap_admin", roleId: result.systemRoles.operations.roleId, reservedCode: true },
    ]);
    assert.deepEqual((await pool.query(`
      SELECT application_id FROM user_role_assignments
      WHERE user_id = 'old-admin' AND status = 'active'
      ORDER BY application_id
    `)).rows.map((row) => row.application_id), ["maintenance", "operations"]);
    assert.ok((await pool.query("SELECT revoked_at FROM sessions WHERE id = 'collision-session'")).rows[0].revoked_at);
    const audit = (await pool.query(`
      SELECT action, after_json
      FROM audit_logs
      WHERE actor_user_id = 'old-admin' AND subject_id = 'old-admin'
      ORDER BY created_at DESC
      LIMIT 1
    `)).rows[0];
    assert.equal(audit.action, "system.cli_bootstrap_legacy_adopted");
    const auditAfter = JSON.parse(audit.after_json);
    assert.equal(auditAfter.adopted, true);
    assert.deepEqual(auditAfter.systemRoles, result.systemRoles);
    await assert.rejects(pool.query(`
      INSERT INTO roles (
        id, application_id, code, name, kind, status, is_system, created_by_user_id
      ) VALUES (
        'reserved-custom-role', 'operations', '__system_bootstrap_operations_attacker',
        'Reserved namespace attacker', 'custom', 'published', false, 'custom-assignee'
      )
    `), /check constraint|violates/i);

    const replay = await bootstrapInternalAdmin(pool, {
      email: "old-admin@example.test",
      password: "another-secure-password",
      adoptLegacyAdmin: true,
      environment,
    });
    assert.deepEqual(replay, { ok: false, code: "ALREADY_BOOTSTRAPPED" });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM system_role_identities")).rows[0].count, 2);
  });
});
