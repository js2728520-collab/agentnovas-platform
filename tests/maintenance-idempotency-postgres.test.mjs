import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  claimMaintenanceIdempotency,
  maintenanceIdempotencyKeyHash,
  runMaintenanceIdempotentCommand,
} from "../lib/maintenance-idempotency.ts";
import { canonicalPayloadHash } from "../lib/commercial-idempotency.ts";
import { runIdempotentMaintenanceSourceIntegrationCheck } from "../lib/maintenance-integration-catalog.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `maintenance_idempotency_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY);
    INSERT INTO users VALUES ('maint-1');
    CREATE TABLE audit_logs (
      id text PRIMARY KEY,
      actor_user_id text,
      action text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      after_json jsonb,
      request_id text,
      trace_id text,
      error_code text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(await readFile(new URL("../postgres/migrations/0039_maintenance_idempotency.sql", import.meta.url), "utf8"));
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE maintenance_idempotency_records,audit_logs");
});

test("same source integration key replays terminal evidence without repeating the external fetch", async () => {
  let fetchCount = 0;
  const input = {
    id: "binance-public-market",
    actorUserId: "maint-1",
    reason: "发布前只读连通检查",
    idempotencyKey: "source-check-key-0001",
    requestId: "request-source-0001",
    traceId: "trace-source-0001",
    now: new Date("2026-08-21T10:00:00.000Z"),
    async fetchImplementation() {
      assert.equal(pool.idleCount, pool.totalCount, "external fetch must not hold a database transaction or client");
      fetchCount += 1;
      return new Response(JSON.stringify({ serverTime: 123 }), { status: 200 });
    },
  };
  const first = await runIdempotentMaintenanceSourceIntegrationCheck(pool, input);
  const replay = await runIdempotentMaintenanceSourceIntegrationCheck(pool, input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);
  assert.equal(fetchCount, 1);
  const evidence = await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='maintenance.integration_test'");
  assert.equal(evidence.rows[0].count, 1);
});

test("same actor and key reject a different canonical payload", async () => {
  const base = {
    operation: "maintenance.trading.emergency_stop",
    actorUserId: "maint-1",
    subjectType: "platform_trading_control",
    subjectId: "platform",
    idempotencyKey: "emergency-key-0001",
    payload: { active: true, reason: "incident containment" },
    requestId: "request-emergency-0001",
  };
  let invoked = 0;
  const first = await runMaintenanceIdempotentCommand(pool, base, async (client) => {
    invoked += 1;
    await client.query("INSERT INTO audit_logs(id,action,subject_type,subject_id) VALUES('audit-1','pause','platform','platform')");
    return { terminalStatus: "succeeded", responseStatus: 200, response: { active: true } };
  });
  const replay = await runMaintenanceIdempotentCommand(pool, base, async () => {
    invoked += 1;
    return { terminalStatus: "succeeded", responseStatus: 200, response: { active: true } };
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(invoked, 1);
  const transactionEvidence = await pool.query(`
    SELECT
      (SELECT xmin::text FROM audit_logs WHERE id='audit-1') AS audit_xmin,
      (SELECT xmin::text FROM maintenance_idempotency_records WHERE operation='maintenance.trading.emergency_stop') AS idempotency_xmin
  `);
  assert.equal(transactionEvidence.rows[0].audit_xmin, transactionEvidence.rows[0].idempotency_xmin);
  await assert.rejects(
    runMaintenanceIdempotentCommand(pool, {
      ...base,
      payload: { active: false, reason: "incident containment" },
    }, async () => ({ terminalStatus: "succeeded", responseStatus: 200, response: { active: false } })),
    (error) => error.code === "IDEMPOTENCY_KEY_COLLISION" && error.status === 409,
  );
});

test("a processing command returns an in-progress conflict and does not invoke the command again", async () => {
  const descriptor = {
    operation: "maintenance.trading.emergency_stop",
    actorUserId: "maint-1",
    subjectType: "platform_trading_control",
    subjectId: "platform",
    idempotencyKey: "emergency-processing-0001",
    payload: { active: true, reason: "incident containment" },
    requestId: "request-processing-0001",
  };
  const claim = await claimMaintenanceIdempotency(pool, descriptor);
  assert.equal(claim.kind, "claimed");
  let invoked = false;
  await assert.rejects(
    runMaintenanceIdempotentCommand(pool, descriptor, async () => {
      invoked = true;
      return { terminalStatus: "succeeded", responseStatus: 200, response: {} };
    }),
    (error) => error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS" && error.status === 409,
  );
  assert.equal(invoked, false);
});

test("an expired source claim becomes an immutable reconciliation failure and never repeats the external call", async () => {
  const descriptor = {
    operation: "maintenance.source_integration.test",
    actorUserId: "maint-1",
    subjectType: "integration",
    subjectId: "binance-public-market",
    idempotencyKey: "source-crash-key-0001",
    payload: { id: "binance-public-market", reason: "crash boundary evidence" },
    requestId: "request-crash-0001",
  };
  await pool.query(`
    INSERT INTO maintenance_idempotency_records(
      id,operation,actor_user_id,idempotency_key_hash,subject_type,subject_id,
      canonical_payload_sha256,request_id,created_at,updated_at,expires_at
    ) VALUES('crashed-source-1',$1,$2,$3,$4,$5,$6,$7,now()-interval '4 minutes',now()-interval '4 minutes',now()-interval '2 minutes')
  `, [
    descriptor.operation,
    descriptor.actorUserId,
    maintenanceIdempotencyKeyHash(descriptor.idempotencyKey),
    descriptor.subjectType,
    descriptor.subjectId,
    canonicalPayloadHash(descriptor.payload),
    descriptor.requestId,
  ]);
  let fetchCount = 0;
  const replay = await runIdempotentMaintenanceSourceIntegrationCheck(pool, {
    ...descriptor,
    id: descriptor.subjectId,
    reason: descriptor.payload.reason,
    async fetchImplementation() {
      fetchCount += 1;
      return new Response(JSON.stringify({ serverTime: 123 }), { status: 200 });
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.terminalStatus, "failed");
  assert.equal(replay.errorCode, "MAINTENANCE_RECONCILIATION_REQUIRED");
  assert.equal(fetchCount, 0);
  const persisted = await pool.query("SELECT status,error_code,response_status FROM maintenance_idempotency_records WHERE id='crashed-source-1'");
  assert.deepEqual(persisted.rows[0], {
    status: "failed",
    error_code: "MAINTENANCE_RECONCILIATION_REQUIRED",
    response_status: 409,
  });
  const reconciliationAudit = await pool.query(`
    SELECT action,error_code,after_json
      FROM audit_logs
     WHERE subject_id='binance-public-market'
  `);
  assert.equal(reconciliationAudit.rows.length, 1);
  assert.equal(reconciliationAudit.rows[0].action, "maintenance.idempotency.reconciliation_required");
  assert.equal(reconciliationAudit.rows[0].error_code, "MAINTENANCE_RECONCILIATION_REQUIRED");
  assert.equal(reconciliationAudit.rows[0].after_json.automaticReplay, false);
  await assert.rejects(
    pool.query("UPDATE maintenance_idempotency_records SET response_status=500 WHERE id='crashed-source-1'"),
    /terminal result is immutable/,
  );
});

test("failed terminal results replay without repeating a failed side effect", async () => {
  let invoked = 0;
  const descriptor = {
    operation: "maintenance.source_integration.test",
    actorUserId: "maint-1",
    subjectType: "integration",
    subjectId: "binance-public-market",
    idempotencyKey: "source-failure-key-0001",
    payload: { reason: "provider failure evidence" },
    requestId: "request-failure-0001",
  };
  const command = async () => {
    invoked += 1;
    return {
      terminalStatus: "failed",
      responseStatus: 502,
      errorCode: "NETWORK_ERROR",
      response: { status: "failed", errorCode: "NETWORK_ERROR" },
    };
  };
  const first = await runMaintenanceIdempotentCommand(pool, descriptor, command);
  const replay = await runMaintenanceIdempotentCommand(pool, descriptor, command);
  assert.equal(first.terminalStatus, "failed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.responseStatus, 502);
  assert.equal(invoked, 1);
});
