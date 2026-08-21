import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { decideAttributionChange, submitAttributionChange } from "../lib/attribution-change-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `attribution_change_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

test.before(async () => {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY,email text NOT NULL,role text NOT NULL,status text NOT NULL,organization_id text,reports_to_user_id text);
    CREATE TABLE organizations(id text PRIMARY KEY);
    CREATE TABLE customer_attributions(id text PRIMARY KEY,customer_id text NOT NULL,branch_id text,manager_id text,supervisor_id text,employee_id text,status text NOT NULL,source text,effective_at timestamptz,reason text,approval_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE customer_attribution_change_requests(id text PRIMARY KEY,request_no text UNIQUE NOT NULL,customer_id text NOT NULL,attribution_id text NOT NULL,branch_id text NOT NULL,previous_assignment_json jsonb NOT NULL,proposed_assignment_json jsonb NOT NULL,expected_attribution_updated_at timestamptz NOT NULL,effective_at timestamptz NOT NULL,reason text NOT NULL,status text NOT NULL DEFAULT 'pending',requested_by_user_id text NOT NULL,decided_by_user_id text,decision_note text,idempotency_key text NOT NULL,request_id text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(requested_by_user_id,idempotency_key));
    CREATE UNIQUE INDEX one_pending_attribution ON customer_attribution_change_requests(attribution_id) WHERE status='pending';
    CREATE TABLE customer_attribution_change_decisions(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,reviewer_user_id text NOT NULL,decision text NOT NULL,note text NOT NULL,idempotency_key text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE notification_deliveries(id text PRIMARY KEY,user_id text,channel text,category text,template_key text,payload_json jsonb,status text,scheduled_at timestamptz,dedupe_key text UNIQUE);
    CREATE TABLE audit_logs(id text PRIMARY KEY,actor_user_id text,action text,subject_type text,subject_id text,before_json jsonb,after_json jsonb,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO organizations(id) VALUES('org');
    INSERT INTO users VALUES
      ('customer','customer@test','customer','active','org',NULL),
      ('maker','maker@test','manager','active','org',NULL),
      ('checker','checker@test','branch_admin','active','org',NULL),
      ('manager-old','old@test','manager','active','org',NULL),
      ('manager-new','new@test','manager','active','org',NULL),
      ('supervisor-new','sup@test','supervisor','active','org','manager-new'),
      ('employee-new','emp@test','employee','active','org','supervisor-new');
    INSERT INTO customer_attributions(id,customer_id,branch_id,manager_id,status,source,effective_at,reason)
    VALUES('attribution','customer','org','manager-old','active','registration',now(),'initial');
  `);
});

test("one checker atomically applies a validated hierarchy snapshot", async () => {
  const request = await submitAttributionChange(pool, { actorUserId: "maker", customerId: "customer", managerId: "manager-new", supervisorId: "supervisor-new", employeeId: "employee-new", effectiveAt: new Date(Date.now() + 60_000).toISOString(), reason: "客户服务团队调整", idempotencyKey: "attribution-submit-1", requestId: "request-one", authorize: async () => undefined });
  const approved = await decideAttributionChange(pool, { actorUserId: "checker", changeId: request.id, decision: "approve", note: "组织关系与生效时间已核对", idempotencyKey: "attribution-decision-1", requestId: "request-two", authorize: async () => undefined });
  assert.equal(approved.status, "approved");
  assert.deepEqual((await pool.query("SELECT manager_id,supervisor_id,employee_id,source FROM customer_attributions WHERE id='attribution'")).rows[0], { manager_id: "manager-new", supervisor_id: "supervisor-new", employee_id: "employee-new", source: "manual_transfer" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM customer_attribution_change_decisions")).rows[0].count, 1);
});

test("self-review, stale snapshots and invalid reporting chains fail closed", async () => {
  await pool.query("UPDATE customer_attributions SET manager_id='manager-old',supervisor_id=NULL,employee_id=NULL,updated_at=now() WHERE id='attribution'");
  const request = await submitAttributionChange(pool, { actorUserId: "maker", customerId: "customer", managerId: "manager-new", supervisorId: "supervisor-new", employeeId: "employee-new", effectiveAt: new Date(Date.now() + 60_000).toISOString(), reason: "再次调整服务团队", idempotencyKey: "attribution-submit-2", requestId: "request-three", authorize: async () => undefined });
  await assert.rejects(() => decideAttributionChange(pool, { actorUserId: "maker", changeId: request.id, decision: "approve", note: "不允许申请人自审", idempotencyKey: "attribution-self", requestId: "self", authorize: async () => undefined }), (error) => error?.code === "ATTRIBUTION_SELF_REVIEW");
  await pool.query("UPDATE customer_attributions SET updated_at=now()+interval '1 second' WHERE id='attribution'");
  await assert.rejects(() => decideAttributionChange(pool, { actorUserId: "checker", changeId: request.id, decision: "approve", note: "快照已经发生变化", idempotencyKey: "attribution-stale", requestId: "stale", authorize: async () => undefined }), (error) => error?.code === "ATTRIBUTION_SNAPSHOT_CHANGED");
  await assert.rejects(() => submitAttributionChange(pool, { actorUserId: "maker", customerId: "customer", managerId: "manager-new", supervisorId: null, employeeId: "employee-new", effectiveAt: new Date(Date.now() + 60_000).toISOString(), reason: "无主管直接分配员工", idempotencyKey: "attribution-invalid-chain", requestId: "invalid", authorize: async () => undefined }), (error) => error?.code === "ATTRIBUTION_HIERARCHY_INVALID");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});
