import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  exportMaintenanceWorkRecords,
  MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS,
} from "../lib/maintenance-work-record-export.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const suffix = `${process.pid}_${Date.now()}`;
const schema = `maintenance_work_record_export_${suffix}`;
const readerRole = `maintenance_work_record_reader_${suffix}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;
let readerPool;

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
  assert.match(readerRole, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-work-record-export-migrations-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE ROLE "${readerRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  // 0075 会从既有部署回填订阅期间。夹具必须在它之前落库，否则回填看不到这些部署，
  // 视图也就没有任何行——那样测试会「通过」在一个空数据集上，什么都证明不了。
  await copyMigrations(74);
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-export-n-minus-one",
  });

  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('customer-a','export-a@quality.invalid','test-only-hash','customer','active'),
      ('customer-b','export-b@quality.invalid','test-only-hash','customer','active');
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
      ('subscription-a','strategy-a','customer-a','active','2026-08-01T00:00:00Z',NULL,'version-a','paper','active'),
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
      ('deployment-a','customer-a','strategy-a','version-a','subscription-a',NULL,'paper','active','UNVERIFIED','export-deployment-a','spot_usdt','ai_conservative','membership-a','portfolio-a'),
      ('deployment-b','customer-b','strategy-b','version-b','subscription-b',NULL,'paper','active','UNVERIFIED','export-deployment-b','spot_usdt','ai_conservative','membership-b','portfolio-b');

    INSERT INTO strategy_decision_rounds(
      id,strategy_code,symbol,timeframe,strategy_version_id,candle_open_time,candle_close_time,
      decision_json,trace_id,completeness
    ) VALUES
      ('round-a-entry','ai_conservative','BTCUSDT','1h','version-a','2026-08-05T11:00:00Z','2026-08-05T12:00:00Z','{"action":"enter_long","riskApproved":true}','trace-a-entry','complete'),
      ('round-a-hold','ai_conservative','BTCUSDT','1h','version-a','2026-08-06T11:00:00Z','2026-08-06T12:00:00Z','{"action":"hold","riskApproved":true}','trace-a-hold','complete'),
      ('round-b-entry','ai_conservative','ETHUSDT','1h','version-b','2026-08-07T11:00:00Z','2026-08-07T12:00:00Z','{"action":"enter_long","riskApproved":true}','trace-b-entry','complete'),
      ('round-a-outside','ai_conservative','BTCUSDT','1h','version-a','2026-09-05T11:00:00Z','2026-09-05T12:00:00Z','{"action":"hold","riskApproved":true}','trace-a-outside','complete');
    INSERT INTO strategy_runtime_cycles(
      id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,
      decision_json,trace_id,started_at,completed_at,decision_round_id
    ) VALUES (
      'cycle-a-entry','deployment-a',1,1,'2026-08-05T11:00:00Z','2026-08-05T12:00:00Z','completed',
      '{"action":"enter_long","riskApproved":true,"riskState":{"drawdownPct":1}}',
      'trace-a-entry','2026-08-05T12:00:01Z','2026-08-05T12:00:02Z','round-a-entry'
    );
  `);

  await copyMigrations(76);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "work-record-export-current",
  });
  assert.deepEqual(upgraded.applied, [
    "0075_strategy_work_record_retention.sql",
    "0076_maintenance_work_record_export.sql",
  ]);

  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${readerRole}"`);
  await admin.query(`GRANT SELECT ON ${schema}.maintenance_strategy_work_records_safe TO "${readerRole}"`);
  readerPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema} -c role=${readerRole}`,
  });
});

test.after(async () => {
  await readerPool?.end();
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.query(`DROP ROLE "${readerRole}"`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("安全视图只投影 allowlist 字段，用户只有单向伪名", async () => {
  const columns = (await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='maintenance_strategy_work_records_safe'
     ORDER BY column_name
  `, [schema])).rows.map((row) => row.column_name);

  // 一旦有人往视图里加字段，这条断言会红。逐字段列出比「不含某某」更强：
  // 后者只能挡住已经想到的泄露，前者要求每个新字段都被显式复核过。
  assert.deepEqual(columns, [
    "admission_status", "candle_count", "candle_open_at", "completeness",
    "customer_pseudonym", "data_end", "data_start", "decision_status",
    "execution_mode", "fill_receipt_count", "is_shared_decision", "market_source",
    "occurred_at", "occurred_day", "order_intent_count", "record_id",
    "strategy_code", "strategy_version_id", "symbol", "timeframe", "trace_id",
  ]);

  // security_barrier 不是装饰：没有它，调用方传入的函数可能先于安全条件求值。
  const options = (await pool.query(`
    SELECT reloptions FROM pg_class WHERE relname='maintenance_strategy_work_records_safe'
       AND relnamespace=$1::regnamespace
  `, [schema])).rows[0];
  assert.ok(options.reloptions.includes("security_barrier=true"));

  const rows = (await pool.query(
    `SELECT customer_pseudonym FROM maintenance_strategy_work_records_safe ORDER BY occurred_at`,
  )).rows;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.customer_pseudonym, /^[a-f0-9]{32}$/);
    assert.ok(!row.customer_pseudonym.includes("customer-"));
  }
  // 同一位客户在导出里可关联，不同客户不可混淆。
  const pseudonyms = new Set(rows.map((row) => row.customer_pseudonym));
  assert.equal(pseudonyms.size, 2);
});

test("Maintenance 数据库角色只能读安全视图，读不到任何工作记录原表", async () => {
  const view = await readerPool.query(
    "SELECT count(*)::int AS total FROM maintenance_strategy_work_records_safe",
  );
  assert.ok(view.rows[0].total > 0, "安全视图必须可读，否则导出无法工作");

  // 视图存在不等于原表已经关上。逐张验证运维端角色拿不到底表——
  // 这是「Maintenance 不展示客户业务信息」在数据库层的实际防线。
  for (const table of [
    "strategy_decision_rounds",
    "strategy_runtime_cycles",
    "strategy_runtime_events",
    "strategy_subscription_periods",
    "official_paper_order_intents",
    "official_paper_fill_receipts",
    "users",
  ]) {
    await assert.rejects(
      readerPool.query(`SELECT 1 FROM ${table} LIMIT 1`),
      (error) => error.code === "42501",
      `${table} 必须对 Maintenance 导出角色不可读`,
    );
  }
});

test("导出按 UTC 日期两端包含，区间外的轮次不出现", async () => {
  const result = await exportMaintenanceWorkRecords(pool, { from: "2026-08-05", to: "2026-08-07" });
  assert.deepEqual(result.rows.map((row) => row.recordId), ["round-b-entry", "round-a-hold", "round-a-entry"]);
  assert.equal(result.truncated, false);
  assert.equal(result.rowCount, 3);
  assert.equal(result.realOrderRoutingEnabled, false);

  // 边界日当天必须包含在内；写成半开区间会静默丢掉最后一天。
  const single = await exportMaintenanceWorkRecords(pool, { from: "2026-08-05", to: "2026-08-05" });
  assert.deepEqual(single.rows.map((row) => row.recordId), ["round-a-entry"]);

  const outside = await exportMaintenanceWorkRecords(pool, { from: "2026-08-01", to: "2026-08-04" });
  assert.deepEqual(outside.rows, []);
  assert.equal(outside.rowCount, 0);
});

test("准入口径与 Client 一致：纯 hold 无周期是无需准入，其余缺周期是未记录", async () => {
  const result = await exportMaintenanceWorkRecords(pool, { from: "2026-08-05", to: "2026-08-07" });
  const byId = Object.fromEntries(result.rows.map((row) => [row.recordId, row]));
  assert.equal(byId["round-a-entry"].admissionStatus, "recorded");
  assert.equal(byId["round-a-hold"].admissionStatus, "not_required");
  // enter_long 且没有客户周期：不能推断为「无需准入」，也不能推断为「已执行」。
  assert.equal(byId["round-b-entry"].admissionStatus, "not_recorded");
});

test("超过上限时如实标记 truncated，不静默声称完整", async () => {
  const rounds = [];
  for (let index = 0; index < MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS + 5; index += 1) {
    const minute = String(index % 60).padStart(2, "0");
    const hour = String(Math.floor(index / 60) % 24).padStart(2, "0");
    const day = String(10 + Math.floor(index / 1440)).padStart(2, "0");
    rounds.push(`('bulk-${index}','ai_conservative','BTCUSDT','1h','version-a',
      '2026-08-${day}T${hour}:${minute}:00Z','2026-08-${day}T${hour}:${minute}:30Z',
      '{"action":"hold","riskApproved":true}','trace-bulk-${index}','complete')`);
  }
  await pool.query(`
    INSERT INTO strategy_decision_rounds(
      id,strategy_code,symbol,timeframe,strategy_version_id,candle_open_time,candle_close_time,
      decision_json,trace_id,completeness
    ) VALUES ${rounds.join(",")}
  `);

  const result = await exportMaintenanceWorkRecords(pool, { from: "2026-08-10", to: "2026-08-12" });
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS);
  assert.equal(result.rows.length, MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS);
  assert.equal(result.maxRows, MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS);
});
