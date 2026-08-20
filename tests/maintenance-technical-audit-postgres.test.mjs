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
      created_at timestamptz NOT NULL, completed_at timestamptz
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
       '2026-08-21T01:00:00Z','2026-08-21T01:00:01Z');
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("maintenance technical audit projects only allowlisted Demo command evidence", async () => {
  const rows = await loadMaintenanceTechnicalAudit(pool, { limit: 10, cursor: null, operation: "control", status: "succeeded" });
  assert.deepEqual(rows, [{
    id: "cmd-1", operation: "control", actorUserId: "maint-1",
    account: { id: "demo-okx", provider: "okx", label: "OKX isolated" },
    action: "kill", strategyCode: null, reason: "incident containment",
    status: "succeeded", errorCode: null,
    createdAt: "2026-08-21T01:00:00.000Z", completedAt: "2026-08-21T01:00:01.000Z",
  }]);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /cipher|idempotency|providerOrder|payload|secret/i);
});

test("technical audit DTO rejects unknown internal states", () => {
  assert.throws(() => maintenanceTechnicalAuditDto({ operation: "future", status: "succeeded" }), /UNKNOWN_AUDIT_OPERATION/);
  assert.throws(() => maintenanceTechnicalAuditDto({ operation: "control", status: "future" }), /UNKNOWN_AUDIT_STATUS/);
});
