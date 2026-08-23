import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import { sha256 } from "../lib/auth.ts";
import {
  consumeInternalRegistrationRateLimit,
  issueInternalRegistrationLink,
  recordInternalRegistrationLinkFailure,
  registerWithInternalRegistrationLink,
  revokeInternalRegistrationLink,
} from "../lib/internal-registration-link-service.ts";
import { legacyRoleAssignments } from "../lib/rbac.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `internal_link_service_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      email_verified_at timestamptz,
      role text NOT NULL,
      organization_id text,
      reports_to_user_id text,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE organizations (
      id text PRIMARY KEY,
      parent_id text,
      type text NOT NULL,
      name text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE applications (id text PRIMARY KEY);
    CREATE TABLE permission_definitions (
      key text PRIMARY KEY,
      application_id text NOT NULL REFERENCES applications(id),
      status text NOT NULL DEFAULT 'active'
    );
    CREATE TABLE roles (
      id text PRIMARY KEY,
      application_id text NOT NULL REFERENCES applications(id),
      code text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      created_organization_id text,
      applies_to_organization_id text,
      status text NOT NULL,
      is_system boolean NOT NULL DEFAULT false,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(application_id,code)
    );
    CREATE TABLE role_permissions (
      id text PRIMARY KEY,
      role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_key text NOT NULL REFERENCES permission_definitions(key),
      scope text NOT NULL,
      scope_organization_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(role_id,permission_key)
    );
    CREATE TABLE user_role_assignments (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      role_id text NOT NULL REFERENCES roles(id),
      application_id text NOT NULL REFERENCES applications(id),
      organization_id text REFERENCES organizations(id),
      scope_organization_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL,
      effective_at timestamptz NOT NULL,
      expires_at timestamptz,
      granted_by_user_id text,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE audit_logs (
      id text PRIMARY KEY,
      actor_user_id text,
      action text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      before_json jsonb,
      after_json jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE auth_rate_limit_buckets (
      id text PRIMARY KEY,
      action text NOT NULL,
      app_audience text NOT NULL,
      bucket_key_hash text NOT NULL,
      window_started_at timestamptz NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      blocked_until timestamptz,
      last_attempt_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE(action,app_audience,bucket_key_hash)
    );
    INSERT INTO applications(id) VALUES ('operations');
    INSERT INTO organizations(id,type,name,status) VALUES
      ('hq-org','headquarters','总部','active'),
      ('branch-1','branch','第一分公司','active'),
      ('branch-2','branch','第二分公司','active');
    INSERT INTO users(id,email,password_hash,role,organization_id,reports_to_user_id,status) VALUES
      ('hq-1','hq@example.com','hash','hq_admin','hq-org',NULL,'active'),
      ('manager-1','manager1@example.com','hash','manager','branch-1','hq-1','active'),
      ('manager-2','manager2@example.com','hash','manager','branch-2','hq-1','active'),
      ('supervisor-1','supervisor1@example.com','hash','supervisor','branch-1','manager-1','active');
  `);
  const permissionKeys = [...new Set(
    ["branch_admin", "manager", "supervisor", "employee"]
      .flatMap((role) => legacyRoleAssignments(role))
      .flatMap((assignment) => assignment.permissions)
      .map((permission) => permission.permissionKey),
  )];
  for (const permissionKey of permissionKeys) {
    await pool.query(
      "INSERT INTO permission_definitions(key,application_id) VALUES($1,'operations')",
      [permissionKey],
    );
  }
  const migration = await readFile(
    new URL("../postgres/migrations/0065_internal_registration_links.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

test("签发长期权限链接时只保存摘要并冻结角色、权限与组织范围", async () => {
  const issued = await issueInternalRegistrationLink(pool, {
    issuerUserId: "manager-1",
    issuerRole: "manager",
    issuerOrganizationId: "branch-1",
    targetRole: "employee",
    targetOrganizationId: null,
    now: new Date("2026-08-23T01:00:00.000Z"),
  });

  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, null);
  const link = (await pool.query(
    "SELECT * FROM internal_registration_links WHERE id=$1",
    [issued.id],
  )).rows[0];
  assert.notEqual(link.token_hash, issued.token);
  assert.equal(link.token_hash, await sha256(issued.token));
  assert.equal(link.target_role, "employee");
  assert.equal(link.organization_id, "branch-1");
  assert.equal(link.status, "active");
  const permissions = (await pool.query(
    "SELECT permission_key,scope FROM role_permissions WHERE role_id=$1 ORDER BY permission_key",
    [link.role_id],
  )).rows;
  assert.deepEqual(permissions, link.permission_snapshot_json);
  assert.equal(await sha256(JSON.stringify(permissions)), link.permission_snapshot_sha256);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM audit_logs WHERE action='internal_registration_link.created' AND subject_id=$1",
    [issued.id],
  )).rows[0].count, 1);
});

test("重生成原子撤销同授权范围旧链接且不会改写旧 token", async () => {
  const replacement = await issueInternalRegistrationLink(pool, {
    issuerUserId: "manager-1",
    issuerRole: "manager",
    issuerOrganizationId: "branch-1",
    targetRole: "employee",
    targetOrganizationId: null,
  });
  const rows = (await pool.query(`
    SELECT id,status,revoked_at,revoked_by_user_id
      FROM internal_registration_links
     WHERE issuer_user_id='manager-1' AND target_role='employee'
     ORDER BY created_at,id
  `)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.status === "active").length, 1);
  assert.equal(rows.find((row) => row.id === replacement.id).status, "active");
  const old = rows.find((row) => row.id !== replacement.id);
  assert.equal(old.status, "revoked");
  assert.equal(old.revoked_by_user_id, "manager-1");
  assert.ok(old.revoked_at);
});

test("同一有效链接可重复注册且每个账号立即获得 published assignment", async () => {
  const issued = await issueInternalRegistrationLink(pool, {
    issuerUserId: "manager-2",
    issuerRole: "manager",
    issuerOrganizationId: "branch-2",
    targetRole: "employee",
    targetOrganizationId: null,
  });
  const first = await registerWithInternalRegistrationLink(pool, {
    tokenHash: await sha256(issued.token),
    email: "employee.one@example.com",
    passwordHash: "argon2-one",
    ipAddress: "203.0.113.10",
    userAgent: "test-agent",
  });
  const second = await registerWithInternalRegistrationLink(pool, {
    tokenHash: await sha256(issued.token),
    email: "employee.two@example.com",
    passwordHash: "argon2-two",
    ipAddress: "203.0.113.11",
    userAgent: "test-agent",
  });
  assert.notEqual(first.userId, second.userId);
  for (const result of [first, second]) {
    assert.equal(result.status, "active");
    assert.equal(result.organizationId, "branch-2");
    const identity = (await pool.query("SELECT * FROM users WHERE id=$1", [result.userId])).rows[0];
    assert.equal(identity.status, "active");
    assert.equal(identity.role, "employee");
    assert.equal(identity.reports_to_user_id, "manager-2");
    const assignment = (await pool.query(`
      SELECT assignment.status,role.status AS role_status
        FROM user_role_assignments assignment
        JOIN roles role ON role.id=assignment.role_id
       WHERE assignment.user_id=$1
    `, [result.userId])).rows[0];
    assert.equal(assignment.status, "active");
    assert.equal(assignment.role_status, "published");
  }
  const link = (await pool.query(
    "SELECT use_count,last_used_at FROM internal_registration_links WHERE id=$1",
    [issued.id],
  )).rows[0];
  assert.equal(Number(link.use_count), 2);
  assert.ok(link.last_used_at);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM internal_registration_link_uses WHERE link_id=$1",
    [issued.id],
  )).rows[0].count, 2);
});

test("总公司分公司管理员链接在注册事务内创建分公司并绑定权限", async () => {
  const issued = await issueInternalRegistrationLink(pool, {
    issuerUserId: "hq-1",
    issuerRole: "hq_admin",
    issuerOrganizationId: "hq-org",
    targetRole: "branch_admin",
    targetOrganizationId: null,
  });
  const registered = await registerWithInternalRegistrationLink(pool, {
    tokenHash: await sha256(issued.token),
    email: "branch.admin@example.com",
    passwordHash: "argon2-branch",
    organizationName: "新加坡分公司",
    ipAddress: null,
    userAgent: null,
  });
  assert.equal(registered.status, "active");
  const organization = (await pool.query(
    "SELECT type,name,status FROM organizations WHERE id=$1",
    [registered.organizationId],
  )).rows[0];
  assert.deepEqual(organization, { type: "branch", name: "新加坡分公司", status: "active" });
});

test("撤销后旧链接不能注册且重复撤销不会伪造成功", async () => {
  const issued = await issueInternalRegistrationLink(pool, {
    issuerUserId: "supervisor-1",
    issuerRole: "supervisor",
    issuerOrganizationId: "branch-1",
    targetRole: "employee",
    targetOrganizationId: null,
  });
  const revoked = await revokeInternalRegistrationLink(pool, {
    linkId: issued.id,
    actorUserId: "supervisor-1",
  });
  const tokenHash = await sha256(issued.token);
  assert.equal(revoked.revoked, true);
  await assert.rejects(
    () => revokeInternalRegistrationLink(pool, { linkId: issued.id, actorUserId: "supervisor-1" }),
    (error) => error?.code === "INTERNAL_REGISTRATION_LINK_NOT_ACTIVE",
  );
  await assert.rejects(
    () => registerWithInternalRegistrationLink(pool, {
      tokenHash,
      email: "blocked@example.com",
      passwordHash: "argon2-blocked",
      ipAddress: null,
      userAgent: null,
    }),
    (error) => error?.code === "INTERNAL_REGISTRATION_LINK_INVALID",
  );
});

test("并发使用相同邮箱只创建一个身份和一条使用事实", async () => {
  const issued = await issueInternalRegistrationLink(pool, {
    issuerUserId: "manager-2",
    issuerRole: "manager",
    issuerOrganizationId: "branch-2",
    targetRole: "supervisor",
    targetOrganizationId: null,
  });
  const input = {
    tokenHash: await sha256(issued.token),
    email: "race@example.com",
    passwordHash: "argon2-race",
    ipAddress: null,
    userAgent: null,
  };
  const results = await Promise.allSettled([
    registerWithInternalRegistrationLink(pool, input),
    registerWithInternalRegistrationLink(pool, input),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "EMAIL_TAKEN").length, 1);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM internal_registration_link_uses WHERE link_id=$1",
    [issued.id],
  )).rows[0].count, 1);
});

test("匿名注册按邮箱、token 和网络三桶限流且失败审计不保存明文 token", async () => {
  const now = new Date("2026-08-23T06:00:00.000Z");
  let result;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    result = await consumeInternalRegistrationRateLimit(pool, {
      email: "limited@example.com",
      tokenHash: "9".repeat(64),
      connectionBucketKey: "ip:203.0.113.20",
      now,
    });
  }
  assert.equal(result.allowed, false);
  assert.ok(result.retryAfterSeconds > 0);
  const buckets = (await pool.query(`
    SELECT action,app_audience,bucket_key_hash FROM auth_rate_limit_buckets
  `)).rows;
  assert.ok(buckets.length >= 3);
  assert.ok(buckets.every((bucket) => bucket.action === "register" && bucket.app_audience === "operations"));
  assert.ok(buckets.every((bucket) => /^[0-9a-f]{64}$/.test(bucket.bucket_key_hash)));
  await recordInternalRegistrationLinkFailure(pool, {
    tokenHash: "9".repeat(64),
    code: "RATE_LIMITED",
    ipAddress: "203.0.113.20",
    userAgent: "test-agent",
    now,
  });
  const audit = (await pool.query(`
    SELECT subject_id,after_json::text FROM audit_logs
     WHERE action='internal_registration_link.failed'
     ORDER BY created_at DESC LIMIT 1
  `)).rows[0];
  assert.equal(audit.subject_id, `token-hash:${"9".repeat(16)}`);
  assert.equal(JSON.stringify(audit).includes("staff-invite"), false);
});
