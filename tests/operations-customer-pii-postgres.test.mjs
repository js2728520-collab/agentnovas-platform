import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  loadOperationsCustomerPii,
  recordOperationsCustomerPiiAudit,
} from "../lib/operations-customer-pii-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `customer_pii_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY,email text NOT NULL,phone text,role text NOT NULL);
    CREATE TABLE notification_channels (user_id text,channel text,destination text,status text);
    CREATE TABLE audit_logs (
      id text PRIMARY KEY,actor_user_id text,action text NOT NULL,subject_type text NOT NULL,
      subject_id text NOT NULL,after_json jsonb,ip_address text,user_agent text,request_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sessions (
      id text PRIMARY KEY,user_id text,ip_address text,user_agent text,
      created_at timestamptz NOT NULL,last_seen_at timestamptz
    );
    CREATE TABLE deposit_orders (user_id text,credited_amount numeric,order_status text);
    CREATE TABLE revenue_events (customer_id text,amount_usdt numeric,status text);
    CREATE TABLE exchange_accounts (
      id text PRIMARY KEY,customer_id text,exchange text,label text,environment text,status text,
      can_read integer,can_trade integer,last_checked_at timestamptz,created_at timestamptz,
      encrypted_credential_ref text,withdrawal_credential_ref text
    );
    CREATE TABLE trades (
      id text PRIMARY KEY,exchange_account_id text,customer_id text,symbol text,side text,status text,
      opened_at timestamptz,closed_at timestamptz,quantity numeric,entry_value_usdt numeric
    );
    CREATE TABLE applications (id text PRIMARY KEY);
    CREATE TABLE permission_definitions (
      key text PRIMARY KEY,application_id text NOT NULL REFERENCES applications(id),label text NOT NULL,
      sensitive boolean NOT NULL,status text NOT NULL
    );
    INSERT INTO applications(id) VALUES ('operations');
    INSERT INTO users VALUES ('customer-1','alice@example.com','+8613812345678','customer');
    INSERT INTO notification_channels VALUES
      ('customer-1','telegram','@alice','verified'),
      ('customer-1','whatsapp','+8613812345678','verified');
    INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,ip_address,created_at)
    VALUES ('registration','customer-1','customer.registered','user','customer-1','203.0.113.25','2026-01-01');
    INSERT INTO sessions VALUES
      ('old','customer-1','198.51.100.10','Firefox on Linux','2026-01-02','2026-01-02'),
      ('new','customer-1','198.51.100.42','Mozilla/5.0 (Macintosh) Chrome/140.0','2026-01-03','2026-01-04');
    INSERT INTO deposit_orders VALUES ('customer-1',1000.25,'CREDITED'),('customer-1',25,'FAILED');
    INSERT INTO revenue_events VALUES ('customer-1',99,'confirmed'),('customer-1',12,'reversed');
    INSERT INTO exchange_accounts VALUES
      ('account-1','customer-1','okx','main','demo','active',1,1,NULL,'2026-01-03','secret-ref','withdraw-ref');
    INSERT INTO trades VALUES
      ('open-1','account-1','customer-1','BTC-USDT','buy','filled','2026-01-05',NULL,0.1,6500),
      ('closed-1','account-1','customer-1','ETH-USDT','buy','closed','2026-01-02','2026-01-03',1,3000);
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("Postgres PII loader returns exact aggregates but never credential references", async () => {
  const rows = await loadOperationsCustomerPii(pool, ["customer-1"]);
  const customer = rows.get("customer-1");
  assert.equal(customer.email, "alice@example.com");
  assert.equal(customer.registrationIpAddress, "203.0.113.25");
  assert.equal(customer.lastLoginIpAddress, "198.51.100.42");
  assert.equal(customer.cumulativeDepositUsdt, "1000.25");
  assert.equal(customer.cumulativeSpendUsdt, "99");
  assert.equal(customer.exchangeAccounts.length, 1);
  assert.equal(customer.openPositions.length, 1);
  assert.equal(customer.openPositions[0].symbol, "BTC-USDT");
  assert.doesNotMatch(JSON.stringify(customer), /secret-ref|withdraw-ref/);
});

test("Postgres PII audits persist scope and redacted reason without customer plaintext", async () => {
  await recordOperationsCustomerPiiAudit(pool, {
    actorUserId: "operator-1",
    action: "customer.pii_viewed",
    subjectType: "customer",
    subjectId: "customer-1",
    categories: ["contact", "security"],
    reason: "核对 alice@example.com、13812345678 与 203.0.113.25 的异常登录",
    scope: "ORGANIZATION",
    organizationIds: ["branch-1"],
    resultCount: 1,
    requestId: "request-1",
  });
  const row = (await pool.query("SELECT * FROM audit_logs WHERE action='customer.pii_viewed'")).rows[0];
  const serialized = JSON.stringify(row.after_json);
  assert.doesNotMatch(serialized, /alice@example\.com|13812345678|203\.0\.113\.25/);
  assert.equal(row.request_id, "request-1");
  assert.deepEqual(row.after_json.categories, ["contact", "security"]);
  assert.deepEqual(row.after_json.organizationIds, ["branch-1"]);
});

test("0068 is idempotent, keeps all customer PII permissions sensitive, and grants none by default", async () => {
  const sql = await readFile(new URL("../postgres/migrations/0068_operations_customer_pii_permissions.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  const definitions = await pool.query("SELECT key,sensitive,status FROM permission_definitions ORDER BY key");
  assert.equal(definitions.rows.length, 5);
  assert.ok(definitions.rows.every((row) => row.sensitive && row.status === "active"));
});
