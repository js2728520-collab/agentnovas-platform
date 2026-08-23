import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import { provisionInternalExperienceAccount } from "../lib/internal-experience-account.ts";

// 员工的体验账号：独立的客户账号，不计业绩。
//
// 为什么必须独立：migration 0040 的 RESTRICTIVE RLS 让客户端 Web 的数据库角色只能
// 看到 role='customer' 的用户与会话。工号账号进不去客户端，而放开那条 RLS 等于让
// 公网应用的数据库角色读到全部内部账号。
//
// 为什么必须不计业绩：员工若用自己的邀请链接注册体验账号，仓位会算成他自己的业绩，
// 主管、经理、分公司跟着一路分成——可以自我刷单。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `internal_exp_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, email text UNIQUE, phone text, password_hash text,
      role text NOT NULL, status text NOT NULL DEFAULT 'active',
      organization_id text, reports_to_user_id text,
      created_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE customer_attributions (
      id text PRIMARY KEY, customer_id text NOT NULL REFERENCES users(id),
      source text NOT NULL, status text NOT NULL,
      branch_id text, manager_id text, supervisor_id text, employee_id text,
      effective_at text, ended_at text, reason text NOT NULL DEFAULT '', approval_id text,
      created_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE audit_logs (
      id text PRIMARY KEY, actor_user_id text, action text NOT NULL,
      subject_type text NOT NULL, subject_id text NOT NULL,
      before_json text, after_json text,
      created_at text NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO users (id,email,role,organization_id) VALUES
      ('emp-1','emp1@x.com','employee','org-1'),
      ('cust-x','custx@x.com','customer',NULL);
  `);
  await pool.query(await readFile(new URL("../postgres/migrations/0056_internal_customer_accounts.sql", import.meta.url), "utf8"));
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

function input(overrides = {}) {
  return {
    ownerUserId: "emp-1",
    customerUserId: "exp-1",
    email: "emp1.experience@x.com",
    phone: "13800000001",
    passwordHash: "hash",
    reason: "熟悉客户端业务流程",
    organizationId: "org-1",
    now: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

test("体验账号是独立的 customer 账号", async () => {
  const result = await provisionInternalExperienceAccount(pool, input());
  assert.equal(result.customerId, "exp-1");
  const row = (await pool.query("SELECT role, organization_id FROM users WHERE id='exp-1'")).rows[0];
  assert.equal(row.role, "customer", "必须是 customer，否则进不了客户端（0040 的 RLS）");
  assert.equal(row.organization_id, null, "体验账号不属于任何组织");
});

test("归因行标为内部，且不挂在任何人的业绩上", async () => {
  const row = (await pool.query("SELECT * FROM customer_attributions WHERE customer_id='exp-1'")).rows[0];
  assert.equal(row.is_internal, true);
  assert.equal(row.internal_owner_user_id, "emp-1");
  assert.ok(row.internal_reason);
  // 这四个为空是关键：体验账号不属于任何人的业绩。
  for (const field of ["employee_id", "manager_id", "supervisor_id"]) {
    assert.equal(row[field], null, `${field} 必须为空，否则体验账号会算进业绩`);
  }
});

test("一人只能有一个体验账号", async () => {
  // 多个的话「哪个是他的」没有答案，运营在客户列表里会看到同一个人的多条记录。
  await assert.rejects(
    () => provisionInternalExperienceAccount(pool, input({ customerUserId: "exp-2", email: "e2@x.com" })),
    /INTERNAL_EXPERIENCE_ALREADY_EXISTS/,
  );
});

test("客户不能给自己开体验账号", async () => {
  await assert.rejects(
    () => provisionInternalExperienceAccount(pool, input({
      ownerUserId: "cust-x", customerUserId: "exp-3", email: "e3@x.com",
    })),
    /INTERNAL_EXPERIENCE_OWNER_NOT_INTERNAL/,
  );
});

test("原因必填", async () => {
  // 一个没有说明的内部账号，事后没人知道它为什么不计业绩。
  await assert.rejects(
    () => provisionInternalExperienceAccount(pool, input({
      ownerUserId: "emp-1", customerUserId: "exp-4", email: "e4@x.com", reason: "   ",
    })),
    /INTERNAL_EXPERIENCE_REASON_REQUIRED/,
  );
});

test("失败时不留下半个账号", async () => {
  // 前面那两次失败都发生在插入 users 之后吗？不——归属校验在最前面，
  // 但重复校验在插入之前，事务保证任何一步失败都不留痕。
  const orphans = await pool.query("SELECT id FROM users WHERE id IN ('exp-2','exp-3','exp-4')");
  assert.deepEqual(orphans.rows, []);
});

test("创建动作留审计", async () => {
  const row = (await pool.query("SELECT action, actor_user_id FROM audit_logs WHERE subject_id='exp-1'")).rows[0];
  assert.equal(row.action, "internal_experience_account.created");
  assert.equal(row.actor_user_id, "emp-1");
});
