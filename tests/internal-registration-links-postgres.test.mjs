import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `internal_role_links_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE organizations (id text PRIMARY KEY);
    CREATE TABLE applications (id text PRIMARY KEY);
    CREATE TABLE permission_definitions (key text PRIMARY KEY);
    CREATE TABLE roles (
      id text PRIMARY KEY,
      application_id text NOT NULL REFERENCES applications(id),
      code text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      is_system boolean NOT NULL DEFAULT false,
      created_by_user_id text,
      UNIQUE (application_id, code)
    );
    CREATE TABLE role_permissions (
      id text PRIMARY KEY,
      role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_key text NOT NULL REFERENCES permission_definitions(key),
      scope text NOT NULL,
      scope_organization_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      UNIQUE (role_id, permission_key)
    );
    INSERT INTO users(id) VALUES ('hq-1'),('manager-1'),('registered-1');
    INSERT INTO organizations(id) VALUES ('branch-1'),('branch-2');
    INSERT INTO applications(id) VALUES ('operations');
    INSERT INTO permission_definitions(key) VALUES ('ops.customers.view'),('ops.customers.manage');
    INSERT INTO roles(id,application_id,code,name,kind,status,created_by_user_id)
    VALUES
      ('role-link-1','operations','registration_link_1','员工权限链接','custom','published','hq-1'),
      ('role-unprotected','operations','unprotected','未冻结角色','custom','published','hq-1');
    INSERT INTO role_permissions(id,role_id,permission_key,scope)
    VALUES
      ('rp-1','role-link-1','ops.customers.view','SELF'),
      ('rp-unprotected','role-unprotected','ops.customers.manage','SELF');
  `);
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

async function applyMigration() {
  const sql = await readFile(
    new URL("../postgres/migrations/0065_internal_registration_links.sql", import.meta.url),
    "utf8",
  );
  await pool.query(sql);
}

async function insertLink(overrides = {}) {
  const row = {
    id: crypto.randomUUID(),
    tokenHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
    issuerUserId: "hq-1",
    roleId: "role-link-1",
    targetRole: "employee",
    organizationMode: "EXISTING_ORGANIZATION",
    organizationId: "branch-1",
    permissionSnapshot: [{ permissionKey: "ops.customers.view", scope: "SELF" }],
    permissionHash: "b".repeat(64),
    ...overrides,
  };
  await pool.query(`
    INSERT INTO internal_registration_links (
      id, token_hash, issuer_user_id, role_id, target_role, organization_mode,
      organization_id, permission_snapshot_json, permission_snapshot_sha256
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
  `, [
    row.id, row.tokenHash, row.issuerUserId, row.roleId, row.targetRole,
    row.organizationMode, row.organizationId, JSON.stringify(row.permissionSnapshot), row.permissionHash,
  ]);
  return row;
}

test("0065 迁移可重复执行", async () => {
  await applyMigration();
  await applyMigration();
});

test("每个生成者、角色和组织范围只能有一条生效链接", async () => {
  await insertLink();
  await assert.rejects(() => insertLink(), /uq_internal_registration_links_active_grant/);
  await insertLink({ targetRole: "supervisor", tokenHash: "c".repeat(64) });
  await insertLink({ organizationId: "branch-2", tokenHash: "d".repeat(64) });
});

test("分公司总经理链接只能创建新分公司，其他角色必须锁定既有分公司", async () => {
  await assert.rejects(() => insertLink({
    targetRole: "branch_admin",
    organizationMode: "EXISTING_ORGANIZATION",
    organizationId: "branch-1",
    tokenHash: "e".repeat(64),
  }), /internal_registration_links_scope_shape/);
  await assert.rejects(() => insertLink({
    targetRole: "employee",
    organizationMode: "CREATE_BRANCH",
    organizationId: null,
    tokenHash: "f".repeat(64),
  }), /internal_registration_links_scope_shape/);

  await insertLink({
    targetRole: "branch_admin",
    organizationMode: "CREATE_BRANCH",
    organizationId: null,
    tokenHash: "1".repeat(64),
  });
});

test("目标角色、权限快照和组织范围创建后不可静默修改", async () => {
  const link = await insertLink({
    issuerUserId: "manager-1",
    organizationId: "branch-1",
    tokenHash: "2".repeat(64),
  });
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_links SET target_role='supervisor' WHERE id=$1", [link.id]),
    /INTERNAL_REGISTRATION_LINK_CONTRACT_IMMUTABLE/,
  );
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_links SET organization_id='branch-2' WHERE id=$1", [link.id]),
    /INTERNAL_REGISTRATION_LINK_CONTRACT_IMMUTABLE/,
  );
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_links SET permission_snapshot_json='[]'::jsonb WHERE id=$1", [link.id]),
    /INTERNAL_REGISTRATION_LINK_CONTRACT_IMMUTABLE/,
  );
});

test("注册链接引用的角色及权限在链接历史存在期间不可改写", async () => {
  await assert.rejects(
    () => pool.query("UPDATE roles SET name='已改名' WHERE id='role-link-1'"),
    /INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE/,
  );
  await assert.rejects(
    () => pool.query("UPDATE role_permissions SET scope='PLATFORM' WHERE id='rp-1'"),
    /INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM role_permissions WHERE id='rp-1'"),
    /INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE/,
  );
  await assert.rejects(
    () => pool.query("UPDATE role_permissions SET role_id='role-link-1' WHERE id='rp-unprotected'"),
    /INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE/,
  );
});

test("撤销不可逆且必须记录操作者和时间", async () => {
  const link = await insertLink({
    issuerUserId: "manager-1",
    organizationId: "branch-2",
    tokenHash: "3".repeat(64),
  });
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_links SET status='revoked' WHERE id=$1", [link.id]),
    /internal_registration_links_revocation_shape/,
  );
  await pool.query(`
    UPDATE internal_registration_links
       SET status='revoked', revoked_at=now(), revoked_by_user_id='hq-1', updated_at=now()
     WHERE id=$1
  `, [link.id]);
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_links SET status='active' WHERE id=$1", [link.id]),
    /INTERNAL_REGISTRATION_LINK_REACTIVATION_FORBIDDEN/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM internal_registration_links WHERE id=$1", [link.id]),
    /INTERNAL_REGISTRATION_LINK_APPEND_ONLY/,
  );
});

test("每次成功注册形成不可改写的独立使用事实", async () => {
  const link = (await pool.query(
    "SELECT id FROM internal_registration_links WHERE target_role='employee' AND organization_id='branch-1' LIMIT 1",
  )).rows[0];
  await pool.query(`
    INSERT INTO internal_registration_link_uses (id, link_id, registered_user_id, used_at)
    VALUES ('use-1',$1,'registered-1',now())
  `, [link.id]);
  await assert.rejects(
    () => pool.query("UPDATE internal_registration_link_uses SET registered_user_id='hq-1' WHERE id='use-1'"),
    /INTERNAL_REGISTRATION_LINK_USE_APPEND_ONLY/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM internal_registration_link_uses WHERE id='use-1'"),
    /INTERNAL_REGISTRATION_LINK_USE_APPEND_ONLY/,
  );
});
