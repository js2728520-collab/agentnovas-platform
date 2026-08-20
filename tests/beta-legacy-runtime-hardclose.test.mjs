import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { leaseNextResearchRun } from "../lib/postgres-research-queue.ts";
import { processResearchStage } from "../lib/strategy-research-orchestrator.ts";
import { processLeasedStrategyRuntimeDeployment } from "../lib/strategy-runtime-worker.ts";

test("legacy research leasing is hard-closed before any database or customer credential access", async () => {
  let queries = 0;
  const database = { async query() { queries += 1; throw new Error("database must not be touched"); } };
  const leased = await leaseNextResearchRun(database, {
    workerId: "beta-research-worker",
    now: new Date("2026-08-21T00:00:00.000Z"),
    leaseSeconds: 30,
  });
  assert.equal(leased, null);
  assert.equal(queries, 0);
});

test("legacy research processing rejects before role, perpetual, or exchange-account work", async () => {
  let queries = 0;
  const database = { async query() { queries += 1; throw new Error("database must not be touched"); } };
  await assert.rejects(processResearchStage(database, {
    id: "legacy-research",
    ownerUserId: "customer",
    conversationId: null,
    exchangeAccountId: "customer-secret-account",
    mode: "standard",
    stage: "data_loading",
    status: "running",
    brief: { exchange: "binance", symbol: "BTCUSDT", market: "usdt_perpetual" },
    agentRoleSnapshot: {},
    result: null,
    candidateBudget: 1,
    backtestBudget: 1,
    modelCallBudget: 1,
    backtestsUsed: 0,
    attempts: 1,
  }, "legacy-worker"), /Beta.*(关闭|禁用)|legacy.*disabled/i);
  assert.equal(queries, 0);
});

test("runtime processing rejects a legacy perpetual lease before adapter, funding, or customer-account work", async () => {
  let adapterCalls = 0;
  let queries = 0;
  const database = { async query() { queries += 1; throw new Error("database must not be touched"); } };
  await assert.rejects(processLeasedStrategyRuntimeDeployment(database, {
    id: "legacy-deployment",
    ownerUserId: "customer",
    strategyId: "strategy",
    strategyVersionId: "version",
    exchangeAccountId: "customer-secret-account",
    mode: "paper",
    validationLabel: "UNVERIFIED",
    fencingToken: 1,
    lastCandleCloseAt: null,
    riskState: {},
    positionSizePct: 10,
    stopLossPctOverride: null,
    specification: { market: "usdt_perpetual" },
    executionProduct: "usdt_perpetual",
    platformStrategyCode: null,
    membershipId: null,
    paperPortfolioId: null,
    membershipStatus: null,
    membershipExpiresAt: null,
    membershipGraceEndsAt: null,
    exchange: "binance",
  }, "legacy-runtime", {
    createAdapter() { adapterCalls += 1; throw new Error("adapter must not be touched"); },
  }), /Beta.*(关闭|禁用)|legacy.*disabled/i);
  assert.equal(adapterCalls, 0);
  assert.equal(queries, 0);
});

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `beta_legacy_hardclose_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE strategy_deployments (
      id text PRIMARY KEY, status text NOT NULL, execution_product text NOT NULL,
      lease_owner text, lease_expires_at timestamptz, last_error_code text,
      last_error_message text, risk_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE audit_logs (
      id text PRIMARY KEY, actor_user_id text, action text NOT NULL,
      subject_type text NOT NULL, subject_id text NOT NULL,
      before_json text, after_json text, ip_address text, user_agent text,
      created_at text NOT NULL DEFAULT ''
    );
    CREATE TABLE strategy_research_runs (
      id text PRIMARY KEY, status text NOT NULL, cancel_requested_at timestamptz,
      completed_at timestamptz, lease_owner text, lease_expires_at timestamptz,
      last_error_code text, last_error_message text, event_sequence bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE strategy_agent_events (
      id text PRIMARY KEY, run_id text NOT NULL REFERENCES strategy_research_runs(id),
      sequence bigint NOT NULL, role text NOT NULL, event_type text NOT NULL,
      title text NOT NULL, content_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(run_id, sequence)
    );
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
});

test("0029 terminally disposes legacy runtime and research work while preserving audit evidence", async () => {
  await pool.query(`
    INSERT INTO strategy_deployments(id,status,execution_product,lease_owner,lease_expires_at)
    VALUES ('legacy-active','active','usdt_perpetual','old-worker',now()+interval '1 hour'),
           ('legacy-paused','paused','usdt_perpetual',NULL,NULL),
           ('official-active','active','spot_usdt',NULL,NULL);
    INSERT INTO strategy_research_runs(id,status,lease_owner,lease_expires_at)
    VALUES ('research-queued','queued',NULL,NULL),
           ('research-retry','retry_wait',NULL,NULL),
           ('research-running','running','old-worker',now()+interval '1 hour'),
           ('research-input','awaiting_user_input',NULL,NULL),
           ('research-complete','completed',NULL,NULL);
  `);
  const migration = await readFile(
    new URL("../postgres/migrations/0029_beta_legacy_runtime_hard_close.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);

  const deployments = await pool.query(`
    SELECT id,status,lease_owner,last_error_code,risk_state_json
    FROM strategy_deployments ORDER BY id
  `);
  const byDeployment = Object.fromEntries(deployments.rows.map((row) => [row.id, row]));
  for (const id of ["legacy-active", "legacy-paused"]) {
    assert.equal(byDeployment[id].status, "ended");
    assert.equal(byDeployment[id].lease_owner, null);
    assert.equal(byDeployment[id].last_error_code, "BETA_LEGACY_RUNTIME_DISABLED");
    assert.equal(byDeployment[id].risk_state_json.halted, true);
  }
  assert.equal(byDeployment["official-active"].status, "active");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM audit_logs WHERE action='strategy.runtime.beta_hard_close'`)).rows[0].count, 2);

  const runs = await pool.query(`SELECT id,status,lease_owner,last_error_code,event_sequence FROM strategy_research_runs ORDER BY id`);
  const byRun = Object.fromEntries(runs.rows.map((row) => [row.id, row]));
  for (const id of ["research-queued", "research-retry", "research-running", "research-input"]) {
    assert.equal(byRun[id].status, "cancelled");
    assert.equal(byRun[id].lease_owner, null);
    assert.equal(byRun[id].last_error_code, "BETA_LEGACY_RESEARCH_DISABLED");
    assert.equal(Number(byRun[id].event_sequence), 1);
  }
  assert.equal(byRun["research-complete"].status, "completed");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM strategy_agent_events WHERE event_type='beta_hard_close'`)).rows[0].count, 4);
});
