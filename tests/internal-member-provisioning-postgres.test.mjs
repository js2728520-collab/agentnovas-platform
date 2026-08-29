import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { provisionInternalMember } from "../lib/internal-member-provisioning.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `internal_member_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO organizations (id, type, name) VALUES ('org-a', 'branch', 'A');
    INSERT INTO users (id, email, password_hash, role, organization_id, status)
    VALUES ('manager', 'manager@example.test', 'disabled', 'manager', 'org-a', 'active');
    INSERT INTO permission_definitions (key, application_id, label, sensitive, status)
    VALUES
      ('maint.ai_usage.view', 'maintenance', '查看 AI 用量与可靠性', true, 'active'),
      ('maint.work_records.export', 'maintenance', '导出脱敏工作记录', true, 'active'),
      ('maint.releases.view', 'maintenance', '查看发布版本', false, 'active'),
      ('maint.releases.manage', 'maintenance', '登记发布版本', true, 'active'),
      ('maint.releases.workflow.view', 'maintenance', '查看受限发布工作流', false, 'active'),
      ('maint.releases.workflow.stage', 'maintenance', '请求与复核 staging 发布', true, 'active'),
      ('maint.releases.workflow.production.request', 'maintenance', '请求 production 发布', true, 'active'),
      ('maint.releases.workflow.activation.request', 'maintenance', '请求发布 activation', true, 'active'),
      ('maint.configuration_versions.view', 'maintenance', '查看版本化配置', false, 'active'),
      ('maint.configuration_versions.manage', 'maintenance', '管理配置草稿与测试', true, 'active')
    ON CONFLICT (key) DO NOTHING
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("an invited internal member, explicit assignment, audience token, and encrypted outbox row commit atomically", async () => {
  await provisionInternalMember(pool, {
    actorUserId: "manager",
    userId: "employee",
    email: "employee@example.test",
    passwordHash: "disabled",
    role: "employee",
    organizationId: "org-a",
    reportsToUserId: "manager",
    activationTokenHash: "activation-hash",
    encryptedNotificationToken: "v1.encrypted.payload",
    now: new Date("2026-08-20T00:00:00.000Z"),
  });
  const assignment = (await pool.query(`
    SELECT assignment.application_id, assignment.scope_organization_ids_json, role.status,
           array_agg(permission.permission_key ORDER BY permission.permission_key) AS permissions
    FROM user_role_assignments assignment
    JOIN roles role ON role.id = assignment.role_id
    JOIN role_permissions permission ON permission.role_id = role.id
    WHERE assignment.user_id = 'employee'
    GROUP BY assignment.id, role.id
  `)).rows[0];
  assert.equal(assignment.application_id, "operations");
  assert.deepEqual(assignment.scope_organization_ids_json, ["org-a"]);
  assert.equal(assignment.status, "published");
  assert.ok(assignment.permissions.includes("ops.team.view"));
  const token = (await pool.query("SELECT token_audience FROM auth_tokens WHERE user_id = 'employee'")).rows[0];
  assert.equal(token.token_audience, "operations");
  const delivery = (await pool.query("SELECT payload_json, secret_kind, secret_expires_at FROM notification_deliveries WHERE user_id = 'employee'")).rows[0];
  assert.doesNotMatch(delivery.payload_json, /activation-hash|one-time-bearer/);
  assert.match(delivery.payload_json, /encryptedToken/);
  assert.equal(JSON.parse(delivery.payload_json).expiresAt, "2026-08-22T00:00:00.000Z");
  assert.equal(delivery.secret_kind, "internal_account_invite");
  assert.equal(delivery.secret_expires_at.toISOString(), "2026-08-22T00:00:00.000Z");
});

test("a technical member receives only a Maintenance role, activation audience, and technical permissions", async () => {
  await provisionInternalMember(pool, {
    actorUserId: "manager",
    userId: "technician",
    email: "technician@example.test",
    passwordHash: "disabled",
    role: "tech_staff",
    organizationId: "org-a",
    reportsToUserId: "manager",
    activationTokenHash: "technical-activation-hash",
    encryptedNotificationToken: "v1.technical.encrypted.payload",
    now: new Date("2026-08-20T00:00:00.000Z"),
  });

  const assignment = (await pool.query(`
    SELECT assignment.application_id, role.code,
           array_agg(permission.permission_key ORDER BY permission.permission_key) AS permissions
    FROM user_role_assignments assignment
    JOIN roles role ON role.id = assignment.role_id
    JOIN role_permissions permission ON permission.role_id = role.id
    WHERE assignment.user_id = 'technician'
    GROUP BY assignment.id, role.id
  `)).rows[0];
  assert.equal(assignment.application_id, "maintenance");
  assert.equal(assignment.code, "maint_technical");
  assert.ok(assignment.permissions.includes("maint.ai_usage.view"));
  assert.ok(assignment.permissions.includes("maint.work_records.export"));
  assert.equal(assignment.permissions.some((permission) => permission.startsWith("ops.")), false);

  const token = (await pool.query("SELECT token_audience FROM auth_tokens WHERE user_id = 'technician'")).rows[0];
  assert.equal(token.token_audience, "maintenance");
  const delivery = (await pool.query("SELECT payload_json FROM notification_deliveries WHERE user_id = 'technician'")).rows[0];
  assert.equal(JSON.parse(delivery.payload_json).audience, "maintenance");
});
