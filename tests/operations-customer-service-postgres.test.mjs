import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { changeOperationsCustomerStatus } from "../lib/operations-customer-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `ops_customer_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

test.before(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY,role text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE sessions(id text PRIMARY KEY,user_id text NOT NULL,revoked_at timestamptz);
    CREATE TABLE customer_profiles(id text PRIMARY KEY,customer_id text NOT NULL UNIQUE,display_name text NOT NULL DEFAULT '',contact_note text NOT NULL DEFAULT '',archived_at timestamptz,archived_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE memberships(id text PRIMARY KEY,customer_id text NOT NULL,status text NOT NULL,expires_at timestamptz);
    CREATE TABLE official_paper_portfolios(id text PRIMARY KEY,membership_id text NOT NULL,customer_id text NOT NULL,access_status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE official_paper_positions(id text PRIMARY KEY,portfolio_id text NOT NULL,quantity numeric NOT NULL);
    CREATE TABLE notification_deliveries(id text PRIMARY KEY,user_id text NOT NULL,channel text NOT NULL,category text NOT NULL,template_key text NOT NULL,payload_json jsonb NOT NULL,status text NOT NULL,scheduled_at timestamptz NOT NULL,dedupe_key text UNIQUE);
    CREATE TABLE audit_logs(id text PRIMARY KEY,actor_user_id text,action text NOT NULL,subject_type text NOT NULL,subject_id text NOT NULL,before_json jsonb,after_json jsonb,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO users(id,role,status) VALUES('customer','customer','active'),('actor','hq_admin','active');
    INSERT INTO sessions(id,user_id) VALUES('session','customer');
    INSERT INTO customer_profiles(id,customer_id) VALUES('profile','customer');
    INSERT INTO memberships(id,customer_id,status,expires_at) VALUES('membership','customer','active',now()+interval '10 days');
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,access_status) VALUES
      ('flat','membership','customer','active'),('open','membership','customer','active');
    INSERT INTO official_paper_positions(id,portfolio_id,quantity) VALUES('position','open',1);
  `);
});

test("freeze revokes sessions and makes paper portfolios close-only or read-only atomically", async () => {
  const result = await changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "freeze", reason: "异常登录调查",
    authorize: async () => undefined,
  });
  assert.equal(result.status, "frozen");
  assert.equal((await pool.query("SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE id='session'")).rows[0].revoked, true);
  assert.deepEqual((await pool.query("SELECT id,access_status FROM official_paper_portfolios ORDER BY id")).rows, [
    { id: "flat", access_status: "read_only" },
    { id: "open", access_status: "close_only" },
  ]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='customer.freeze'")).rows[0].count, 1);
});

test("restore reopens only valid membership portfolios and archive remains reversible", async () => {
  const restored = await changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "restore", reason: "调查完成",
    authorize: async () => undefined,
  });
  assert.equal(restored.status, "active");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_portfolios WHERE access_status='active'")).rows[0].count, 2);
  await changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "archive", reason: "客户申请关闭",
    authorize: async () => undefined,
  });
  assert.equal((await pool.query("SELECT archived_at IS NOT NULL AS archived FROM customer_profiles WHERE customer_id='customer'")).rows[0].archived, true);
  await changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "restore", reason: "客户申请恢复",
    authorize: async () => undefined,
  });
  assert.equal((await pool.query("SELECT archived_at IS NULL AS restored FROM customer_profiles WHERE customer_id='customer'")).rows[0].restored, true);
});

test("authorization and state conflicts fail without partial mutation", async () => {
  await assert.rejects(() => changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "freeze", reason: "越权测试",
    authorize: async () => { throw new Error("DENIED"); },
  }), /DENIED/);
  assert.equal((await pool.query("SELECT status FROM users WHERE id='customer'")).rows[0].status, "active");
  await assert.rejects(() => changeOperationsCustomerStatus(pool, {
    actorUserId: "actor", customerId: "customer", action: "restore", reason: "重复恢复",
    authorize: async () => undefined,
  }), (error) => error?.code === "CUSTOMER_STATE_CONFLICT");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});
