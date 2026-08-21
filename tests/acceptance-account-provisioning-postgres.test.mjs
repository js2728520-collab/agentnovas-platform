import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { verifyPassword } from "../lib/auth.ts";
import { provisionAcceptanceAccounts } from "../lib/acceptance-account-provisioning.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `acceptance_accounts_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

const credentials = {
  client: {
    email: "client-admin@agentnovas.com",
    password: "client-only-test-password-123",
  },
  operations: {
    email: "operations-admin@agentnovas.com",
    password: "operations-only-test-password-123",
  },
  maintenance: {
    email: "maintenance-admin@agentnovas.com",
    password: "maintenance-only-test-password-123",
  },
};

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
    INSERT INTO organizations (id, type, name, status)
    VALUES ('hq', 'headquarters', 'Riverton Capital 总公司', 'active');
    INSERT INTO users (
      id, email, password_hash, role, organization_id, status, email_verified_at
    ) VALUES (
      'bootstrap-admin', 'existing-admin@agentnovas.com', 'not-used',
      'hq_admin', 'hq', 'active', now()::text
    );
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("three audience acceptance accounts are provisioned atomically with explicit least-cross-audience access", async () => {
  const result = await provisionAcceptanceAccounts(pool, credentials);
  assert.equal(result.ok, true);
  assert.equal(result.actorUserId, "bootstrap-admin");
  assert.deepEqual(Object.keys(result.accounts).sort(), ["client", "maintenance", "operations"]);

  const users = (await pool.query(`
    SELECT id, email, password_hash, role, organization_id, reports_to_user_id
    FROM users
    WHERE email = ANY($1::text[])
    ORDER BY email
  `, [Object.values(credentials).map((credential) => credential.email)])).rows;
  assert.equal(users.length, 3);

  for (const audience of ["client", "operations", "maintenance"]) {
    const credential = credentials[audience];
    const user = users.find((candidate) => candidate.email === credential.email);
    assert.ok(user);
    assert.match(user.password_hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(credential.password, user.password_hash), true);
    assert.equal(user.password_hash.includes(credential.password), false);
    assert.equal(user.role, audience === "client" ? "customer" : "employee");
    assert.equal(user.organization_id, audience === "client" ? null : "hq");
    assert.equal(user.reports_to_user_id, audience === "client" ? null : "bootstrap-admin");
  }

  const assignments = (await pool.query(`
    SELECT account.email, assignment.application_id, permission.permission_key, permission.scope
    FROM users AS account
    JOIN user_role_assignments AS assignment ON assignment.user_id = account.id
    JOIN roles AS role ON role.id = assignment.role_id
    JOIN role_permissions AS permission ON permission.role_id = role.id
    WHERE account.email = ANY($1::text[])
      AND assignment.status = 'active'
      AND role.status = 'published'
    ORDER BY account.email, permission.permission_key
  `, [Object.values(credentials).map((credential) => credential.email)])).rows;
  for (const audience of ["client", "operations", "maintenance"]) {
    const email = credentials[audience].email;
    const accountGrants = assignments.filter((row) => row.email === email);
    const catalog = (await pool.query(`
      SELECT key FROM permission_definitions
      WHERE application_id = $1 AND status = 'active'
      ORDER BY key
    `, [audience])).rows.map((row) => row.key);
    assert.deepEqual(accountGrants.map((row) => row.permission_key), catalog);
    assert.ok(accountGrants.every((row) => row.application_id === audience));
    assert.ok(accountGrants.every((row) => row.scope === (audience === "client" ? "SELF" : "PLATFORM")));
  }

  assert.equal((await pool.query(`
    SELECT count(*)::int AS count
    FROM user_mfa_totp_credentials AS credential
    JOIN users AS account ON account.id = credential.user_id
    WHERE account.email = ANY($1::text[])
  `, [Object.values(credentials).map((credential) => credential.email)])).rows[0].count, 0);

  const audits = (await pool.query(`
    SELECT actor_user_id, action, after_json
    FROM audit_logs
    WHERE action = 'system.acceptance_account_provisioned'
    ORDER BY created_at, id
  `)).rows;
  assert.equal(audits.length, 3);
  assert.ok(audits.every((audit) => audit.actor_user_id === "bootstrap-admin"));
  const auditBody = JSON.stringify(audits);
  for (const credential of Object.values(credentials)) {
    assert.equal(auditBody.includes(credential.password), false);
  }
});

test("provisioning is fail-closed and cannot overwrite or partially recreate credentials", async () => {
  await assert.rejects(
    provisionAcceptanceAccounts(pool, credentials),
    /ACCEPTANCE_ACCOUNT_ALREADY_EXISTS/,
  );
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM users
    WHERE email = ANY($1::text[])
  `, [Object.values(credentials).map((credential) => credential.email)])).rows[0].count, 3);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM user_role_assignments AS assignment
    JOIN users AS account ON account.id = assignment.user_id
    WHERE account.email = ANY($1::text[])
  `, [Object.values(credentials).map((credential) => credential.email)])).rows[0].count, 3);
});

test("provisioning rejects duplicate identities before touching the database", async () => {
  await assert.rejects(provisionAcceptanceAccounts(pool, {
    client: { email: "same@agentnovas.com", password: "first-strong-test-password" },
    operations: { email: "SAME@agentnovas.com", password: "second-strong-test-password" },
    maintenance: { email: "other@agentnovas.com", password: "third-strong-test-password" },
  }), /ACCEPTANCE_ACCOUNT_EMAILS_NOT_DISTINCT/);
});

test("provisioning rejects weak or control-character passwords before touching the database", async () => {
  await assert.rejects(provisionAcceptanceAccounts(pool, {
    client: { email: "weak-client@agentnovas.com", password: "too-short" },
    operations: { email: "new-operations@agentnovas.com", password: "operations-password-long-enough" },
    maintenance: { email: "new-maintenance@agentnovas.com", password: "maintenance-password-long-enough" },
  }), /ACCEPTANCE_ACCOUNT_PASSWORD_INVALID:client/);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM users WHERE email='weak-client@agentnovas.com'
  `)).rows[0].count, 0);
});

test("the CLI never accepts passwords in command arguments or prints credential material", async () => {
  const source = await readFile(new URL("../scripts/provision-acceptance-accounts.mjs", import.meta.url), "utf8");
  assert.match(source, /ALLOW_ACCEPTANCE_ACCOUNT_PROVISIONING/);
  assert.match(source, /ACCEPTANCE_CREDENTIAL_OUTPUT/);
  assert.match(source, /randomToken/);
  assert.doesNotMatch(source, /process\.argv|console\.log\([^)]*password|stdout\.write\([^)]*password/i);
  assert.match(source, /mode:\s*0o600/);
  assert.match(source, /flag:\s*["']wx["']/);
  assert.doesNotMatch(source, /truncate\(/);
});
