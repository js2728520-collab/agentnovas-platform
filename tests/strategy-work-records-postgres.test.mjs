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
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_work_records_${process.pid}_${Date.now()}`;
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

async function copyMigration(name) {
  const source = new URL("../postgres/migrations/", import.meta.url);
  await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
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
      ('customer-b','customer-b@quality.invalid','test-only-hash','customer','active');
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
  await copyMigrations(75);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-current",
  });
  assert.deepEqual(upgraded.applied, ["0075_strategy_work_record_retention.sql"]);
  await copyMigration("0089_strategy_work_record_truncate_retention.sql");
  const hardened = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-truncate-retention",
  });
  assert.deepEqual(hardened.applied, ["0089_strategy_work_record_truncate_retention.sql"]);
  const rerun = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-truncate-retention-rerun",
  });
  assert.deepEqual(rerun.applied, []);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
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

test("work-record truth cannot be deleted before the six-month minimum retention", async () => {
  await assert.rejects(
    () => pool.query("DELETE FROM strategy_decision_rounds WHERE id='round-a-hold'"),
    /six-month minimum retention/i,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM strategy_deployments WHERE id='deployment-a'"),
    /six-month minimum retention/i,
  );

  await pool.query(`
    INSERT INTO strategy_decision_rounds(
      id,strategy_code,symbol,timeframe,strategy_version_id,candle_open_time,candle_close_time,
      decision_json,trace_id,completeness,created_at
    ) VALUES (
      'round-old-cleanable','ai_conservative','SOLUSDT','1h','version-a',
      now() - interval '8 months',now() - interval '8 months' + interval '1 hour',
      '{}','trace-old-cleanable','complete',now() - interval '7 months'
    )
  `);
  await pool.query("DELETE FROM strategy_decision_rounds WHERE id='round-old-cleanable'");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_decision_rounds WHERE id='round-old-cleanable'")).rows[0].count, 0);
});

test("TRUNCATE retention resolves the triggering relation by OID despite a shadow table", async () => {
  await pool.query(`CREATE TEMP TABLE strategy_decision_rounds (created_at timestamptz)`);
  await assert.rejects(
    () => pool.query(`TRUNCATE ONLY "${schema}".strategy_decision_rounds CASCADE`),
    /six-month minimum retention/i,
  );
});

test("permanent paper receipts and ledger entries cannot be truncated", async () => {
  await pool.query(`
    INSERT INTO official_paper_order_intents(
      id,portfolio_id,deployment_id,runtime_cycle_id,idempotency_key,symbol,action,
      execution_timing,status,payload_json
    ) VALUES (
      'intent-retention','portfolio-a','deployment-a','cycle-a-admitted','retention-intent',
      'BTCUSDT','buy','next_candle_open','pending','{}'
    );
    INSERT INTO official_paper_fill_receipts(
      id,intent_id,portfolio_id,symbol,action,quantity,fill_price,notional_usdt,
      fee_usdt,trace_id,filled_at
    ) VALUES (
      'receipt-retention','intent-retention','portfolio-a','BTCUSDT','buy',1,1,1,0,
      'trace-retention',now()
    );
    INSERT INTO official_paper_ledger_entries(
      id,portfolio_id,fill_receipt_id,entry_type,amount_usdt,balance_after_usdt,
      symbol,trace_id,occurred_at
    ) VALUES (
      'ledger-retention','portfolio-a','receipt-retention','buy',1,9999,'BTCUSDT',
      'trace-retention',now()
    );
  `);
  await assert.rejects(
    () => pool.query("TRUNCATE official_paper_fill_receipts, official_paper_ledger_entries CASCADE"),
    /permanent work-record evidence cannot be truncated/i,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_fill_receipts WHERE id='receipt-retention'")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_ledger_entries WHERE id='ledger-retention'")).rows[0].count, 1);
});

test("TRUNCATE and TRUNCATE CASCADE cannot bypass the six-month minimum retention", async () => {
  await assert.rejects(
    () => pool.query("TRUNCATE strategy_decision_rounds CASCADE"),
    /six-month minimum retention/i,
  );
  await assert.rejects(
    () => pool.query("TRUNCATE strategy_deployments CASCADE"),
    /six-month minimum retention/i,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_decision_rounds WHERE id='round-a-hold'")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_deployments WHERE id='deployment-a'")).rows[0].count, 1);
});
