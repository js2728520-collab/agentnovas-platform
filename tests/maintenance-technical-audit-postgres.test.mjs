import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  loadMaintenanceTechnicalAudit,
  maintenanceTechnicalAuditDto,
} from "../lib/maintenance-technical-audit.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `maint_technical_audit_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE platform_demo_accounts (
      id text PRIMARY KEY, provider text NOT NULL, label text NOT NULL,
      enabled boolean NOT NULL, kill_switch_enabled boolean NOT NULL,
      api_key_ciphertext text NOT NULL, secret_ciphertext text NOT NULL,
      passphrase_ciphertext text, last_verified_at timestamptz,
      last_verification_status text, created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE VIEW platform_demo_accounts_safe AS
      SELECT id,provider,label,enabled,kill_switch_enabled,
        api_key_ciphertext<>'' AS has_api_key,secret_ciphertext<>'' AS has_secret,
        passphrase_ciphertext IS NOT NULL AS has_passphrase,last_verified_at,
        last_verification_status,created_at,updated_at
      FROM platform_demo_accounts;
    CREATE TABLE platform_demo_admin_commands (
      id text PRIMARY KEY, operation text NOT NULL, idempotency_key text NOT NULL,
      actor_user_id text NOT NULL, account_id text NOT NULL, action text NOT NULL,
      strategy_code text, reason text NOT NULL, canonical_payload_sha256 text NOT NULL,
      status text NOT NULL, response_json jsonb, error_code text,
      request_id text, trace_id text,
      created_at timestamptz NOT NULL, completed_at timestamptz
    );
    CREATE TABLE audit_logs (
      id text PRIMARY KEY,actor_user_id text,action text NOT NULL,
      subject_type text NOT NULL,subject_id text NOT NULL,request_id text,trace_id text,
      after_json text,error_code text,created_at timestamptz NOT NULL
    );
    INSERT INTO platform_demo_accounts
      (id,provider,label,enabled,kill_switch_enabled,api_key_ciphertext,secret_ciphertext,
       passphrase_ciphertext,last_verified_at,last_verification_status,created_at,updated_at)
    VALUES
      ('demo-okx','okx','OKX isolated',false,true,'cipher-api','cipher-secret','cipher-pass',NULL,NULL,now(),now());
    INSERT INTO platform_demo_admin_commands VALUES
      ('cmd-1','control','private-idempotency','maint-1','demo-okx','kill',NULL,
       'incident containment','${"a".repeat(64)}','succeeded',
       '{"secret":"must-not-leak","providerOrderId":"private"}',NULL,
       'req-demo-001','trace-demo-001',
       '2026-08-21T01:00:00Z','2026-08-21T01:00:01Z');
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,
      request_id,trace_id,error_code,created_at
    ) VALUES (
      'audit-failed','maint-1','maintenance.integration_test','integration','binance-public-market',
      '{"status":"failed","errorCode":"HTTP_503","latencyMs":12,"reason":"provider readiness check"}',
      'req-integration-001','trace-integration-001','HTTP_503','2026-08-21T02:00:00Z'
    );
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,
      request_id,trace_id,error_code,created_at
    ) VALUES (
      'audit-release','maint-2','release.deploy.succeeded','release_deployment','deployment-1',
      '{"releaseVersionId":"release-1","environment":"staging","reason":"staging smoke verified","evidenceSha256":"${"b".repeat(64)}"}',
      'req-release-001',NULL,NULL,'2026-08-21T03:00:00Z'
    );
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("maintenance technical audit projects allowlisted cross-domain evidence", async () => {
  const rows = await loadMaintenanceTechnicalAudit(pool, { limit: 10, cursor: null, operation: "control", status: "succeeded" });
  assert.deepEqual(rows, [{
    id: "demo:cmd-1", domain: "demo", actorUserId: "maint-1",
    subject: { id: "demo-okx", type: "platform_demo_account", label: "okx · OKX isolated" },
    action: "demo.control.kill", reason: "incident containment",
    status: "succeeded", errorCode: null,
    requestId: "req-demo-001", traceId: "trace-demo-001",
    createdAt: "2026-08-21T01:00:00.000Z", completedAt: "2026-08-21T01:00:01.000Z",
  }]);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /cipher|idempotency|providerOrder|payload|secret/i);
});

test("technical audit DTO rejects unknown internal states", () => {
  assert.throws(() => maintenanceTechnicalAuditDto({ domain: "future", action: "safe", status: "succeeded" }), /UNKNOWN_AUDIT_DOMAIN/);
  assert.throws(() => maintenanceTechnicalAuditDto({ domain: "demo", action: "safe", status: "future" }), /UNKNOWN_AUDIT_STATUS/);
});

test("failed integration checks stay failed and expose only their safe reason", async () => {
  const rows = await loadMaintenanceTechnicalAudit(pool, { limit: 10, cursor: null, domain: "integrations", status: "failed" });
  assert.deepEqual(rows, [{
    id: "audit:audit-failed", domain: "integrations", actorUserId: "maint-1",
    subject: { id: "binance-public-market", type: "integration", label: null },
    action: "maintenance.integration_test", reason: "provider readiness check",
    status: "failed", errorCode: "HTTP_503",
    requestId: "req-integration-001", traceId: "trace-integration-001",
    createdAt: "2026-08-21T02:00:00.000Z", completedAt: "2026-08-21T02:00:00.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(rows), /latencyMs/);
});

test("release evidence appears in its own safe technical audit domain", async () => {
  const rows = await loadMaintenanceTechnicalAudit(pool, { limit: 10, cursor: null, domain: "releases", status: "succeeded" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "releases");
  assert.equal(rows[0].action, "release.deploy.succeeded");
  assert.equal(rows[0].reason, "staging smoke verified");
  assert.doesNotMatch(JSON.stringify(rows), /evidenceSha256|bbbbbbbb/);
});
