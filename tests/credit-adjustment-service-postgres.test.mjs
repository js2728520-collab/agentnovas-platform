import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { decideCreditAdjustment, submitCreditAdjustment } from "../lib/credit-adjustment-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `credit_adjust_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

test.before(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY);
    CREATE TABLE ai_credit_accounts(id text PRIMARY KEY,user_id text UNIQUE NOT NULL,available_credits numeric(36,0) NOT NULL CHECK(available_credits>=0),reserved_credits numeric(36,0) NOT NULL DEFAULT 0 CHECK(reserved_credits>=0),version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ai_credit_ledger_entries(id text PRIMARY KEY,account_id text NOT NULL,entry_type text NOT NULL,available_delta numeric(36,0) NOT NULL,reserved_delta numeric(36,0) NOT NULL,balance_available numeric(36,0) NOT NULL CHECK(balance_available>=0),balance_reserved numeric(36,0) NOT NULL CHECK(balance_reserved>=0),source_type text NOT NULL,source_id text NOT NULL,reservation_id text,cost_model_version text,usage_json jsonb,idempotency_key text UNIQUE NOT NULL,request_id text NOT NULL,created_by_user_id text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_type,source_id,entry_type));
    CREATE TABLE ai_credit_adjustment_requests(id text PRIMARY KEY,request_no text UNIQUE NOT NULL,user_id text NOT NULL,account_id text,amount_delta numeric(36,0) NOT NULL,reason text NOT NULL,evidence_reference text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'pending',requested_by_user_id text NOT NULL,request_id text NOT NULL,idempotency_key text NOT NULL,decided_by_user_id text,decision_note text,requested_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(requested_by_user_id,idempotency_key));
    CREATE UNIQUE INDEX one_pending ON ai_credit_adjustment_requests(user_id) WHERE status='pending';
    CREATE TABLE ai_credit_adjustment_decisions(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,reviewer_user_id text NOT NULL,decision text NOT NULL,note text NOT NULL,idempotency_key text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE notification_deliveries(id text PRIMARY KEY,user_id text NOT NULL,channel text,category text,template_key text,payload_json jsonb,status text,scheduled_at timestamptz,dedupe_key text UNIQUE);
    CREATE TABLE audit_logs(id text PRIMARY KEY,actor_user_id text,action text,subject_type text,subject_id text,before_json jsonb,after_json jsonb,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO users(id) VALUES('customer'),('maker'),('checker'),('checker-two');
  `);
});

test("approval creates the account, immutable ledger entry and balance exactly once", async () => {
  const request = await submitCreditAdjustment(pool, { actorUserId: "maker", customerId: "customer", amountDelta: "1000", reason: "会员补偿积分", evidenceReference: "case-001", idempotencyKey: "submit-001", requestId: "request-submit", authorize: async () => undefined });
  const replay = await submitCreditAdjustment(pool, { actorUserId: "maker", customerId: "customer", amountDelta: "1000", reason: "会员补偿积分", evidenceReference: "case-001", idempotencyKey: "submit-001", requestId: "request-submit", authorize: async () => undefined });
  assert.equal(replay.id, request.id);
  const approved = await decideCreditAdjustment(pool, { actorUserId: "checker", adjustmentId: request.id, decision: "approve", note: "凭证核对无误", idempotencyKey: "decision-001", requestId: "request-decision", authorize: async () => undefined });
  assert.equal(approved.status, "approved");
  assert.equal((await pool.query("SELECT available_credits::text AS value FROM ai_credit_accounts WHERE user_id='customer'")).rows[0].value, "1000");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM ai_credit_ledger_entries")).rows[0].count, 1);
  const decisionReplay = await decideCreditAdjustment(pool, { actorUserId: "checker", adjustmentId: request.id, decision: "approve", note: "凭证核对无误", idempotencyKey: "decision-001", requestId: "request-decision", authorize: async () => undefined });
  assert.equal(decisionReplay.status, "approved");
  assert.equal((await pool.query("SELECT available_credits::text AS value FROM ai_credit_accounts WHERE user_id='customer'")).rows[0].value, "1000");
});

test("negative adjustment cannot overdraw and maker cannot self-approve", async () => {
  const request = await submitCreditAdjustment(pool, { actorUserId: "maker", customerId: "customer", amountDelta: "-2000", reason: "冲正错误发放", evidenceReference: "case-002", idempotencyKey: "submit-002", requestId: "request-submit-two", authorize: async () => undefined });
  await assert.rejects(() => decideCreditAdjustment(pool, { actorUserId: "maker", adjustmentId: request.id, decision: "approve", note: "尝试自审", idempotencyKey: "self-review", requestId: "self", authorize: async () => undefined }), (error) => error?.code === "CREDIT_ADJUSTMENT_SELF_REVIEW");
  await assert.rejects(() => decideCreditAdjustment(pool, { actorUserId: "checker-two", adjustmentId: request.id, decision: "approve", note: "余额不足仍审批", idempotencyKey: "decision-002", requestId: "request-decision-two", authorize: async () => undefined }), (error) => error?.code === "CREDIT_BALANCE_INSUFFICIENT");
  assert.equal((await pool.query("SELECT status FROM ai_credit_adjustment_requests WHERE id=$1", [request.id])).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT available_credits::text AS value FROM ai_credit_accounts WHERE user_id='customer'")).rows[0].value, "1000");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});
