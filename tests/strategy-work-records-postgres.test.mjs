import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  decodeStrategyWorkRecordCursor,
  listClientStrategyWorkRecords,
  loadClientStrategyWorkRecord,
} from "../lib/strategy-work-records.ts";
import { runMaintenanceWorkRecordExport } from "../lib/maintenance-work-record-export.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_work_records_${process.pid}_${Date.now()}`;
const readerRole = `work_record_export_reader_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

async function copyMigrations(maximumVersion) {
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    const version = Number(name.slice(0, 4));
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || version > maximumVersion) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-work-record-migrations-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await copyMigrations(74);
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-n-minus-one",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('customer-a','customer-a@quality.invalid','test-only-hash','customer','active'),
      ('customer-b','customer-b@quality.invalid','test-only-hash','customer','active'),
      ('maint-export','maint-export@quality.invalid','test-only-hash','tech_staff','active');
    INSERT INTO memberships(id,customer_id,plan_code,status) VALUES
      ('membership-a','customer-a','fixture','active'),
      ('membership-b','customer-b','fixture','active');
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,strategy_code,risk_json) VALUES
      ('portfolio-a','membership-a','customer-a','ai_conservative','{}'),
      ('portfolio-b','membership-b','customer-b','ai_conservative','{}');
    INSERT INTO community_strategies(id,author_user_id,name) VALUES
      ('strategy-a','customer-a','Fixture A'),
      ('strategy-b','customer-b','Fixture B');
    INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id) VALUES
      ('version-a','strategy-a',1,'{}','customer-a'),
      ('version-b','strategy-b',1,'{}','customer-b');
    INSERT INTO strategy_subscriptions(
      id,strategy_id,customer_id,status,started_at,ended_at,
      strategy_version_id,run_mode,runtime_status
    ) VALUES
      ('subscription-a','strategy-a','customer-a','ended','2026-08-01T00:00:00Z','2026-08-10T00:00:00Z','version-a','paper','ended'),
      ('subscription-b','strategy-b','customer-b','active','2026-08-01T00:00:00Z',NULL,'version-b','paper','active');
    INSERT INTO platform_strategy_migration_map(
      strategy_code,symbol,strategy_id,strategy_version_id,conversion_contract_sha256
    ) VALUES
      ('ai_conservative','BTCUSDT','strategy-a','version-a',repeat('a',64)),
      ('ai_conservative','ETHUSDT','strategy-b','version-b',repeat('b',64));
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,strategy_subscription_id,
      exchange_account_id,mode,status,validation_label,idempotency_key,
      execution_product,platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES
      ('deployment-a','customer-a','strategy-a','version-a','subscription-a',NULL,'paper','ended','UNVERIFIED','work-record-deployment-a','spot_usdt','ai_conservative','membership-a','portfolio-a'),
      ('deployment-b','customer-b','strategy-b','version-b','subscription-b',NULL,'paper','active','UNVERIFIED','work-record-deployment-b','spot_usdt','ai_conservative','membership-b','portfolio-b');
  `);
  await copyMigrations(76);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-current",
  });
  assert.deepEqual(upgraded.applied, [
    "0075_strategy_work_record_retention.sql",
    "0076_maintenance_work_record_export.sql",
  ]);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("subscription periods backfill immutable ownership and support a later activation period", async () => {
  assert.deepEqual((await pool.query(`
    SELECT customer_id,deployment_id,strategy_code,symbol,started_at,ended_at
    FROM strategy_subscription_periods ORDER BY customer_id
  `)).rows.map((row) => ({
    ...row,
    started_at: row.started_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
  })), [
    {
      customer_id: "customer-a",
      deployment_id: "deployment-a",
      strategy_code: "ai_conservative",
      symbol: "BTCUSDT",
      started_at: "2026-08-01T00:00:00.000Z",
      ended_at: "2026-08-10T00:00:00.000Z",
    },
    {
      customer_id: "customer-b",
      deployment_id: "deployment-b",
      strategy_code: "ai_conservative",
      symbol: "ETHUSDT",
      started_at: "2026-08-01T00:00:00.000Z",
      ended_at: null,
    },
  ]);

  await pool.query(`
    INSERT INTO strategy_subscription_periods(
      id,subscription_id,customer_id,deployment_id,strategy_code,
      strategy_version_id,symbol,mode,started_at
    ) VALUES (
      'period-a-reactivated','subscription-a','customer-a','deployment-a','ai_conservative',
      'version-a','BTCUSDT','paper','2026-08-20T00:00:00Z'
    )
  `);

  await assert.rejects(
    () => pool.query(`
      INSERT INTO strategy_subscription_periods(
        id,subscription_id,customer_id,deployment_id,strategy_code,
        strategy_version_id,symbol,mode,started_at,ended_at
      ) VALUES (
        'period-cross-customer','subscription-a','customer-b','deployment-a','ai_conservative',
        'version-a','BTCUSDT','paper','2026-07-01T00:00:00Z','2026-07-02T00:00:00Z'
      )
    `),
    /facts are inconsistent/i,
  );
  await assert.rejects(
    () => pool.query(`
      INSERT INTO strategy_subscription_periods(
        id,subscription_id,customer_id,deployment_id,strategy_code,
        strategy_version_id,symbol,mode,started_at,ended_at
      ) VALUES (
        'period-overlap','subscription-a','customer-a','deployment-a','ai_conservative',
        'version-a','BTCUSDT','paper','2026-08-02T00:00:00Z','2026-08-03T00:00:00Z'
      )
    `),
    /cannot overlap/i,
  );
});

test("Client list and detail include owned periods and pure hold while failing closed across gaps", async () => {
  await pool.query(`
    INSERT INTO strategy_decision_rounds(
      id,strategy_code,symbol,timeframe,strategy_version_id,candle_open_time,candle_close_time,
      decision_json,trace_id,completeness
    ) VALUES
      ('round-a-admitted','ai_conservative','BTCUSDT','1h','version-a','2026-08-05T11:00:00Z','2026-08-05T12:00:00Z','{"action":"enter_long","riskApproved":true}','trace-a-admitted','complete'),
      ('round-a-gap','ai_conservative','BTCUSDT','1h','version-a','2026-08-15T11:00:00Z','2026-08-15T12:00:00Z','{"action":"hold","riskApproved":true}','trace-a-gap','complete'),
      ('round-a-hold','ai_conservative','BTCUSDT','1h','version-a','2026-08-21T11:00:00Z','2026-08-21T12:00:00Z','{"action":"hold","riskApproved":true}','trace-a-hold','complete'),
      ('round-a-unadmitted','ai_conservative','BTCUSDT','1h','version-a','2026-08-22T11:00:00Z','2026-08-22T12:00:00Z','{"action":"enter_long","riskApproved":true}','trace-a-unadmitted','complete'),
      ('round-a-wrong-version','ai_conservative','BTCUSDT','1h','version-b','2026-08-23T11:00:00Z','2026-08-23T12:00:00Z','{"action":"hold","riskApproved":true}','trace-a-wrong-version','complete'),
      ('round-b-private','ai_conservative','ETHUSDT','1h','version-b','2026-08-22T11:00:00Z','2026-08-22T12:00:00Z','{"action":"hold","riskApproved":true}','trace-b-private','complete');
    INSERT INTO strategy_runtime_cycles(
      id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,
      decision_json,trace_id,started_at,completed_at,decision_round_id
    ) VALUES (
      'cycle-a-admitted','deployment-a',1,1,'2026-08-05T11:00:00Z','2026-08-05T12:00:00Z','completed',
      '{"action":"enter_long","riskApproved":true,"riskState":{"drawdownPct":1}}',
      'trace-a-admitted','2026-08-05T12:00:01Z','2026-08-05T12:00:02Z','round-a-admitted'
    );
    INSERT INTO strategy_runtime_events(
      id,cycle_id,decision_round_id,sequence,role,event_type,conclusion,evidence_json,
      duration_ms,llm_used,explanation_status,created_at
    ) VALUES (
      'event-a-decision',NULL,'round-a-admitted',6,'decision','agent_completed','允许进入模拟准入',
      '{"action":"enter_long","riskApproved":true,"private":"hidden"}',10,false,'not_requested','2026-08-05T12:00:02Z'
    );
  `);

  const page = await listClientStrategyWorkRecords(pool, { userId: "customer-a", limit: 20, cursor: null });
  assert.deepEqual(page.data.map((record) => record.recordId), ["round-a-unadmitted", "round-a-hold", "round-a-admitted"]);
  assert.equal(page.data[0].admissionStatus, "not_recorded");
  assert.equal(page.data[1].admissionStatus, "not_required");
  assert.equal(page.data[2].admissionStatus, "recorded");
  assert.equal(page.data.some((record) => record.recordId === "round-a-wrong-version"), false);

  const firstPage = await listClientStrategyWorkRecords(pool, { userId: "customer-a", limit: 1, cursor: null });
  assert.equal(firstPage.data[0].recordId, "round-a-unadmitted");
  assert.ok(firstPage.nextCursor);
  const secondPage = await listClientStrategyWorkRecords(pool, {
    userId: "customer-a",
    limit: 1,
    cursor: decodeStrategyWorkRecordCursor(firstPage.nextCursor),
  });
  assert.equal(secondPage.data[0].recordId, "round-a-hold");

  const admitted = await loadClientStrategyWorkRecord(pool, { userId: "customer-a", recordId: "round-a-admitted" });
  assert.equal(admitted.admission.cycleId, "cycle-a-admitted");
  assert.equal(admitted.events[0].role, "final_decision");
  assert.doesNotMatch(JSON.stringify(admitted), /hidden/);

  await assert.rejects(
    () => loadClientStrategyWorkRecord(pool, { userId: "customer-a", recordId: "round-a-gap" }),
    (error) => error?.code === "WORK_RECORD_NOT_FOUND" && error?.status === 404,
  );
  await assert.rejects(
    () => loadClientStrategyWorkRecord(pool, { userId: "customer-a", recordId: "round-b-private" }),
    (error) => error?.code === "WORK_RECORD_NOT_FOUND" && error?.status === 404,
  );
});

test("Maintenance safe view exposes pseudonymous allowlisted records while its reader cannot query raw work tables", async () => {
  assert.match(readerRole, /^[a-z0-9_]+$/);
  await admin.query(`CREATE ROLE "${readerRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${readerRole}"`);
  await pool.query(`GRANT SELECT ON maintenance_strategy_work_records_safe TO "${readerRole}"`);

  const columns = (await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='maintenance_strategy_work_records_safe'
     ORDER BY ordinal_position
  `, [schema])).rows.map((row) => row.column_name);
  assert.deepEqual(columns, [
    "work_record_ref", "user_ref", "strategy_code", "strategy_version", "symbol", "timeframe",
    "decision_status", "completeness", "execution_mode", "admission_status", "order_intent_count",
    "fill_receipt_count", "occurred_at", "is_shared_decision", "real_order_routing_enabled",
  ]);
  assert.equal(columns.some((column) => /customer_id|user_id|email|phone|evidence|payload|model|error/i.test(column)), false);

  const restricted = await pool.connect();
  try {
    await restricted.query("BEGIN");
    await restricted.query(`SET LOCAL ROLE "${readerRole}"`);
    await restricted.query(`SET LOCAL search_path TO "${schema}"`);
    const rows = (await restricted.query(`
      SELECT * FROM maintenance_strategy_work_records_safe
      ORDER BY occurred_at,work_record_ref
    `)).rows;
    assert.equal(rows.length, 4, "the gap and wrong-version rounds stay excluded while both customers remain exportable");
    assert.equal(JSON.stringify(rows).includes("customer-a"), false);
    assert.equal(JSON.stringify(rows).includes("customer-b"), false);
    assert.ok(rows.every((row) => /^USR-[A-F0-9]{12}$/.test(row.user_ref)));
    assert.ok(rows.every((row) => /^WRK-[A-F0-9]{16}$/.test(row.work_record_ref)));
    assert.ok(rows.every((row) => row.real_order_routing_enabled === false));
    await assert.rejects(
      restricted.query("SELECT id FROM strategy_decision_rounds LIMIT 1"),
      /permission denied/i,
    );
    await restricted.query("ROLLBACK");
  } finally {
    restricted.release();
  }
});

test("Maintenance export replays one identical result and writes one metadata-only append audit", async () => {
  const input = {
    actorUserId: "maint-export",
    idempotencyKey: "work-record-export-key-0001",
    from: "2026-08-01",
    to: "2026-08-31",
    reason: "月末客户争议核查",
    requestId: "request-work-export-0001",
    traceId: "trace-work-export-0001",
    now: new Date("2026-08-31T12:00:00.000Z"),
  };
  const first = await runMaintenanceWorkRecordExport(pool, input);
  const replay = await runMaintenanceWorkRecordExport(pool, input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);
  assert.equal(first.response.data.length, 4);
  assert.equal(JSON.stringify(first.response).includes("customer-a"), false);
  assert.equal(JSON.stringify(first.response).includes("customer-b"), false);

  const audit = await pool.query(`
    SELECT action,after_json,request_id,trace_id
      FROM audit_logs
     WHERE action='maintenance.work_records.export_generated'
  `);
  assert.equal(audit.rows.length, 1);
  const auditMetadata = JSON.parse(audit.rows[0].after_json);
  assert.deepEqual(auditMetadata, {
    from: "2026-08-01",
    to: "2026-08-31",
    rowCount: 4,
    truncated: false,
    querySha256: auditMetadata.querySha256,
    reason: "月末客户争议核查",
  });
  assert.match(auditMetadata.querySha256, /^[a-f0-9]{64}$/);
  assert.equal("data" in auditMetadata, false);
  assert.equal(audit.rows[0].request_id, input.requestId);
  assert.equal(audit.rows[0].trace_id, input.traceId);

  await assert.rejects(
    runMaintenanceWorkRecordExport(pool, { ...input, reason: "相同键绑定了不同请求" }),
    (error) => error?.code === "IDEMPOTENCY_KEY_COLLISION" && error?.status === 409,
  );
});

test("work-record truth cannot be deleted before the six-month minimum retention", async () => {
  await assert.rejects(
    () => pool.query("DELETE FROM strategy_decision_rounds WHERE id='round-a-hold'"),
    /six-month minimum retention/i,
  );
});
