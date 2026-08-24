import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHash } from "node:crypto";

import pg from "pg";

import {
  applyPaperFundingRates,
  completeRuntimeExplanationJob,
  completeStrategyRuntimeCycle,
  createStrategyDeployment,
  changeStrategyDeploymentStatus,
  endConflictingOfficialStrategyDeployments,
  leaseNextRuntimeExplanationJob,
  leaseNextStrategyDeployment,
  OfficialStrategyGenericResumeBlockedError,
  OfficialStrategyModeSwitchOpenPositionError,
  renewStrategyRuntimeLease,
} from "../lib/strategy-runtime-repository.ts";
import { resolveRuntimeExplanationPrompt } from "../lib/runtime-explanations.ts";
import {
  clearRoundBindingCache,
  processLeasedStrategyRuntimeDeployment,
  processNextRuntimeExplanation,
} from "../lib/strategy-runtime-worker.ts";
import {
  aggregateOfficialThreeCardPreviousUtcWeek,
  ensureOfficialPaperPortfolios,
  resolveOfficialThreeCardPortfolioScope,
  refreshOfficialPaperRiskState,
  restrictOfficialPaperPortfoliosForEmergency,
  settlePendingOfficialPaperOrder,
} from "../lib/official-paper-repository.ts";
import { evaluatePlatformStrategy, PLATFORM_AI_STRATEGIES } from "../packages/domain/src/platform-ai-strategies.ts";
import { platformStrategyDslV3 } from "../packages/domain/src/platform-strategy-v3.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_runtime_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
const pre0024Migrations = [
  "0001_strategy_research.sql",
  "0004_market_data_snapshots.sql",
  "0007_strategy_runtime.sql",
  "0013_runtime_explanations.sql",
  "0020_runtime_final_decision.sql",
];

const dsl = {
  schemaVersion: 3,
  name: "运行时测试策略",
  market: "usdt_perpetual",
  marginMode: "isolated",
  leverage: 1,
  symbol: "BTCUSDT",
  timeframe: "1h",
  direction: "long_only",
  legs: { long: {
    entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
    exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
    stopLossPct: 2,
    takeProfitPct: 4,
  } },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

function officialEntryCandles() {
  for (let seed = 1; seed < 5_000; seed += 1) {
    let randomState = (seed * 97) >>> 0;
    const random = () => {
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    let close = 100;
    const rows = Array.from({ length: 100 }, (_, index) => {
      const open = close;
      close = Math.max(5, open * (1 + 0.0008 + Math.sin((index + seed % 13) / 4) * 0.0015 + (random() - 0.5) * 0.009));
      if (index === 99 && seed % 7 === 0) close *= 1.02;
      const spread = 0.001 + random() * 0.008;
      return {
        openTime: index * 3_600_000,
        closeTime: (index + 1) * 3_600_000 - 1,
        open,
        high: Math.max(open, close) * (1 + spread),
        low: Math.min(open, close) * (1 - spread),
        close,
        volume: (80 + random() * 50) * (index === 99 && seed % 5 === 0 ? 2.5 : 1),
      };
    });
    if (evaluatePlatformStrategy(PLATFORM_AI_STRATEGIES.ai_conservative, "BTCUSDT", rows, false).action === "enter") {
      // Keep both the entry candle and the next settlement candle inside one
      // UTC risk day. Anchoring to wall-clock "now" made this test fail during
      // the last UTC hour because the second cycle correctly reset daily loss.
      const today = new Date();
      const stableCloseTime = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
        12,
      );
      const shift = stableCloseTime - rows.at(-1).closeTime;
      return rows.map((candle) => ({
        ...candle,
        openTime: candle.openTime + shift,
        closeTime: candle.closeTime + shift,
      }));
    }
  }
  throw new Error("official entry fixture not found");
}

async function initializePre0024Schema(database) {
  await database.query(`
    CREATE TABLE strategy_versions (id text PRIMARY KEY, specification_json text NOT NULL);
    CREATE TABLE exchange_accounts (id text PRIMARY KEY, exchange text NOT NULL);
    CREATE TABLE memberships (id text PRIMARY KEY, customer_id text NOT NULL, status text NOT NULL, expires_at text, grace_ends_at text);
    CREATE TABLE strategy_subscriptions (id text PRIMARY KEY);
    CREATE TABLE platform_decisions (id text PRIMARY KEY);
    CREATE TABLE trades (id text PRIMARY KEY);
  `);
  for (const filename of pre0024Migrations) {
    const migration = await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8");
    await database.query(migration);
  }
}

async function initializeEmergencyAccessSchema(database) {
  await database.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      organization_id text
    );
    CREATE TABLE customer_attributions (
      id text PRIMARY KEY,
      customer_id text NOT NULL,
      branch_id text,
      status text NOT NULL,
      effective_at timestamptz
    );
    CREATE TABLE trading_emergency_stops (
      id text PRIMARY KEY,
      scope_key text NOT NULL UNIQUE,
      active boolean NOT NULL DEFAULT false
    );
  `);
}

async function seedDeployment(mode = "shadow", key = crypto.randomUUID()) {
  return createStrategyDeployment(pool, {
    ownerUserId: "owner-a",
    strategyId: "strategy-a",
    strategyVersionId: "version-a",
    exchangeAccountId: "account-a",
    mode,
    validationLabel: "UNVERIFIED",
    idempotencyKey: key,
    riskAcknowledged: true,
  });
}

async function seedOfficialDeployment(mode = "shadow", key = crypto.randomUUID()) {
  const portfolios = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const portfolio = portfolios.find((item) => item.strategyCode === "ai_conservative");
  return createStrategyDeployment(pool, {
    ownerUserId: "owner-official",
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode,
    validationLabel: "UNVERIFIED",
    idempotencyKey: key,
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: "ai_conservative",
    membershipId: "membership-official",
    paperPortfolioId: portfolio.id,
  });
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await initializePre0024Schema(pool);
  const migration0024 = await readFile(new URL("../postgres/migrations/0024_platform_demo_execution.sql", import.meta.url), "utf8");
  // 0060 给组合加 book 维度：同一张卡上模拟盘与实盘各一本账，本金规则按 book 分叉。
  const migration0060 = await readFile(new URL("../postgres/migrations/0060_live_portfolio_book.sql", import.meta.url), "utf8");
  await pool.query(migration0024);
  await pool.query(migration0024);
  await pool.query(migration0060);
  // 共享决策轮（ADR-0018）。跟 0024 一样跑两遍，验证迁移可重复执行。
  const migration0046 = await readFile(new URL("../postgres/migrations/0046_shared_decision_rounds.sql", import.meta.url), "utf8");
  await pool.query(migration0046);
  await pool.query(migration0046);
  const migration0047 = await readFile(new URL("../postgres/migrations/0047_shared_explanation_jobs.sql", import.meta.url), "utf8");
  await pool.query(migration0047);
  await pool.query(migration0047);
  const migration0048 = await readFile(new URL("../postgres/migrations/0048_events_belong_to_decision_round.sql", import.meta.url), "utf8");
  await pool.query(migration0048);
  await pool.query(migration0048);
  await initializeEmergencyAccessSchema(pool);
  // 0078 的绑定表：Worker 现在会在开仓前查这一轮的绑定一致性（ADR-0025）。表不存在时
  // 守卫按不一致处理并拒绝开仓——「查不了就算过」的守卫等于没有守卫，所以这里必须建表，
  // 不能靠放宽守卫让测试变绿。0078 的回填 LEFT JOIN 这张映射表（0010），本套件只挑选
  // 需要的迁移，因此按原定义补一张空表。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_strategy_migration_map (
      strategy_code text NOT NULL,
      symbol text NOT NULL,
      strategy_id text NOT NULL,
      strategy_version_id text NOT NULL,
      conversion_contract_sha256 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (strategy_code, symbol),
      UNIQUE (strategy_id),
      UNIQUE (strategy_version_id)
    );
  `);
  const migration0078 = await readFile(new URL("../postgres/migrations/0078_strategy_market_source_bindings.sql", import.meta.url), "utf8");
  await pool.query(migration0078);
  await pool.query(migration0078);
  // 解释任务入队时会固定 Prompt 配置版本（PS-05），固定列外键指向 configuration_versions，
  // 0080 的两个网关还会读 configuration_activations。0069 整份迁移拖着 RBAC 依赖链，
  // 本套件只挑选需要的迁移，因此按 0069 的形状补两张空表——形状要一致，否则网关的
  // 列引用在创建时就通不过。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuration_versions (
      id text PRIMARY KEY,
      kind text NOT NULL,
      configuration_key text NOT NULL,
      audience text NOT NULL,
      version_number integer NOT NULL,
      schema_version integer NOT NULL,
      payload_json jsonb NOT NULL,
      payload_sha256 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS configuration_activations (
      id text PRIMARY KEY,
      sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      configuration_version_id text NOT NULL REFERENCES configuration_versions(id) ON DELETE RESTRICT,
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const migration0080 = await readFile(new URL("../postgres/migrations/0080_prompt_configuration_task_pinning.sql", import.meta.url), "utf8");
  await pool.query(migration0080);
  await pool.query(migration0080);
  await pool.query(`INSERT INTO strategy_versions (id, specification_json) VALUES ('version-a', $1)`, [JSON.stringify(dsl)]);
  await pool.query(`INSERT INTO strategy_versions (id, specification_json) VALUES ('version-official', $1)`, [JSON.stringify(platformStrategyDslV3("ai_conservative", "BTCUSDT"))]);
  await pool.query(`INSERT INTO exchange_accounts (id, exchange) VALUES ('account-a', 'binance')`);
  await pool.query(`INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at) VALUES ('membership-official', 'owner-official', 'active', NULL, NULL)`);
  await pool.query(`INSERT INTO users (id, organization_id) VALUES ('owner-official', NULL)`);
  await pool.query(`INSERT INTO users (id, organization_id) VALUES ('owner-shared-a', NULL)`);
  await pool.query(`INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at) VALUES ('membership-shared-a', 'owner-shared-a', 'active', NULL, NULL)`);
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE strategy_deployments, official_paper_portfolios, runtime_explanation_bindings, llm_profiles, trading_emergency_stops CASCADE");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("leases with fencing tokens and recovers an expired runtime worker", async () => {
  const deployment = await seedOfficialDeployment("shadow");
  const now = new Date(Date.now() + 60_000);
  const first = await leaseNextStrategyDeployment(pool, { workerId: "runtime-a", now, leaseSeconds: 30 });
  assert.equal(first.id, deployment.id);
  assert.equal(first.fencingToken, 1);

  const unavailable = await leaseNextStrategyDeployment(pool, {
    workerId: "runtime-b", now: new Date(now.getTime() + 10_000), leaseSeconds: 30,
  });
  assert.equal(unavailable, null);

  const renewed = await renewStrategyRuntimeLease(pool, {
    deploymentId: deployment.id,
    workerId: "runtime-a",
    fencingToken: first.fencingToken,
    now: new Date(now.getTime() + 20_000),
    leaseSeconds: 30,
  });
  assert.equal(renewed.leaseExpiresAt.getTime(), now.getTime() + 50_000);

  const stillUnavailable = await leaseNextStrategyDeployment(pool, {
    workerId: "runtime-b", now: new Date(now.getTime() + 31_000), leaseSeconds: 30,
  });
  assert.equal(stillUnavailable, null);

  const recovered = await leaseNextStrategyDeployment(pool, {
    workerId: "runtime-b", now: new Date(now.getTime() + 51_000), leaseSeconds: 30,
  });
  assert.equal(recovered.id, deployment.id);
  assert.equal(recovered.fencingToken, 2);
});

test("deployment idempotency returns the same resource and rejects a changed payload", async () => {
  const key = "same-deployment-request";
  const first = await seedDeployment("shadow", key);
  const repeated = await seedDeployment("shadow", key);

  assert.equal(repeated.id, first.id);
  await assert.rejects(
    createStrategyDeployment(pool, {
      ownerUserId: "owner-a",
      strategyId: "strategy-a",
      strategyVersionId: "version-a",
      exchangeAccountId: "account-a",
      mode: "paper",
      validationLabel: "UNVERIFIED",
      idempotencyKey: key,
      riskAcknowledged: true,
    }),
    error => error?.name === "StrategyDeploymentIdempotencyConflictError",
  );
});

test("persists exactly seven role events and makes a repeated candle idempotent", async () => {
  const deployment = await seedOfficialDeployment("shadow");
  const now = new Date(Date.now() + 60_000);
  const lease = await leaseNextStrategyDeployment(pool, { workerId: "runtime-a", now, leaseSeconds: 30 });
  const events = [
    "market_data", "technical_analysis", "strategy_decision", "adversarial_review",
    "risk", "decision", "execution",
  ].map((role, index) => ({ sequence: index + 1, role, conclusion: role, evidence: {}, durationMs: 0, llmUsed: false }));
  const input = {
    cycleId: "cycle-a", deploymentId: deployment.id, workerId: "runtime-a", fencingToken: lease.fencingToken,
    candleOpenTime: new Date(0), candleCloseTime: new Date(3_599_999), marketDataSnapshotId: "snapshot-a",
    decision: { action: "hold" }, orderIntent: null, events, traceId: "trace-a", startedAt: now,
    nextCycleAt: new Date(now.getTime() + 15_000), positionSizePct: 5,
  };
  const completed = await completeStrategyRuntimeCycle(pool, input);
  const repeated = await completeStrategyRuntimeCycle(pool, input);

  assert.equal(completed.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_runtime_cycles")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_runtime_events")).rows[0].count, 7);
});

test("queues pinned asynchronous explanations without changing deterministic conclusions", async () => {
  await pool.query(`
    INSERT INTO llm_profiles (
      id, name, provider_name, base_url, model_name, encrypted_api_key,
      enabled, current_revision_id, created_by_user_id, updated_by_user_id
    ) VALUES ('runtime-profile', 'Runtime', 'Private', 'https://llm.example.com/v1',
              'runtime-model', 'encrypted', true, 'runtime-revision', 'admin', 'admin')
  `);
  await pool.query(`
    INSERT INTO llm_profile_revisions (
      id, profile_id, revision_number, name, provider_name, base_url,
      model_name, encrypted_api_key, enabled, created_by_user_id
    ) VALUES ('runtime-revision', 'runtime-profile', 1, 'Runtime', 'Private',
              'https://llm.example.com/v1', 'runtime-model', 'encrypted', true, 'admin')
  `);
  for (const role of ["market_summary", "adversarial_explanation", "risk_explanation"]) {
    await pool.query(`
      INSERT INTO runtime_explanation_bindings (
        id, role, llm_profile_id, enabled, updated_by_user_id
      ) VALUES ($1, $2, 'runtime-profile', true, 'admin')
    `, [`binding-${role}`, role]);
  }
  const deployment = await seedOfficialDeployment("shadow");
  const now = new Date(Date.now() + 60_000);
  const lease = await leaseNextStrategyDeployment(pool, { workerId: "runtime-a", now, leaseSeconds: 30 });
  const roles = [
    "market_data", "technical_analysis", "strategy_decision", "adversarial_review",
    "risk", "decision", "execution",
  ];
  const events = roles.map((role, index) => ({
    sequence: index + 1,
    role,
    conclusion: `deterministic:${role}`,
    evidence: role === "market_data" ? { marketState: "trend_up" } : {},
    durationMs: 1,
    llmUsed: false,
  }));
  await completeStrategyRuntimeCycle(pool, {
    cycleId: "cycle-explanation", deploymentId: deployment.id, workerId: "runtime-a", fencingToken: lease.fencingToken,
    candleOpenTime: new Date(0), candleCloseTime: new Date(3_599_999), marketDataSnapshotId: "snapshot-a",
    decision: { action: "enter_long", riskApproved: false, rejectionReasons: ["最大回撤边界已触发"] },
    orderIntent: null, events, traceId: "trace-explanation", startedAt: now,
    nextCycleAt: new Date(now.getTime() + 15_000), positionSizePct: 5,
  });

  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_runtime_explanation_jobs")).rows[0].count, 3);
  const job = await leaseNextRuntimeExplanationJob(pool, {
    workerId: "explanation-worker",
    now: new Date(now.getTime() + 1_000),
    leaseSeconds: 30,
  });
  assert.equal(job.profileRevisionId, "runtime-revision");
  assert.ok(["market_summary", "adversarial_explanation", "risk_explanation"].includes(job.explanationRole));
  await assert.rejects(
    completeRuntimeExplanationJob(pool, {
      jobId: job.id,
      workerId: "wrong-worker",
      fencingToken: job.fencingToken,
      output: { summary: "wrong", evidenceRefs: [], cautions: [] },
      modelName: "runtime-model",
      durationMs: 5,
    }),
    /租约|fencing token/,
  );
  await completeRuntimeExplanationJob(pool, {
    jobId: job.id,
    workerId: "explanation-worker",
    fencingToken: job.fencingToken,
    output: { summary: "仅补充解释，不改变结论。", evidenceRefs: [], cautions: [] },
    modelName: "runtime-model",
    durationMs: 5,
  });
  const event = (await pool.query(`
    SELECT conclusion, explanation_status, explanation_json, explanation_model_name, llm_used
    FROM strategy_runtime_events WHERE cycle_id = 'cycle-explanation' AND role = $1
  `, [job.eventRole])).rows[0];
  assert.equal(event.conclusion, `deterministic:${job.eventRole}`);
  assert.equal(event.explanation_status, "completed");
  assert.equal(event.explanation_json.summary, "仅补充解释，不改变结论。");
  assert.equal(event.explanation_model_name, "runtime-model");
  assert.equal(event.llm_used, true);

  const failedExplanation = await processNextRuntimeExplanation(pool, {
    workerId: "failing-explanation-worker",
  }, {
    now: () => new Date(now.getTime() + 2_000),
    resolveConfig: async (_database, role) => ({
      role,
      profileId: "runtime-profile",
      revisionId: "runtime-revision",
      revisionNumber: 1,
      model: "runtime-model",
      modelName: "runtime-model",
      providerName: "Private",
      endpoint: "https://llm.example.com/v1/chat/completions",
      apiStyle: "chat_completions",
      apiKey: "secret",
    }),
    callExplanation: async () => { throw new Error("运行时解释模型调用超时"); },
  });
  assert.equal(failedExplanation.status, "retry_wait");
  assert.equal(failedExplanation.errorCode, "RUNTIME_EXPLANATION_TIMEOUT");
  const cycle = (await pool.query("SELECT decision_json, status FROM strategy_runtime_cycles WHERE id = 'cycle-explanation'")).rows[0];
  assert.equal(cycle.status, "completed");
  assert.equal(cycle.decision_json.riskApproved, false);
});

test("legacy perpetual paper runtime cannot be leased or reach its adapter", async () => {
  const deployment = await seedDeployment("paper");
  const firstNow = new Date(Date.now() + 60_000);
  const lease = await leaseNextStrategyDeployment(pool, { workerId: "runtime-a", now: firstNow, leaseSeconds: 30 });
  assert.equal(lease, null);
  assert.equal((await pool.query("SELECT status FROM strategy_deployments WHERE id=$1", [deployment.id])).rows[0].status, "active");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_paper_positions WHERE deployment_id=$1", [deployment.id])).rows[0].count, 0);
});

test("positive funding charges longs, credits shorts, and is idempotent by funding timestamp", async () => {
  const deployment = await seedDeployment("paper");
  await pool.query(`
    INSERT INTO strategy_runtime_cycles (
      id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
      status, decision_json, trace_id, started_at
    ) VALUES ('funding-cycle', $1, 1, 1, now() - interval '2 hours', now() - interval '1 hour',
              'completed', '{}', 'funding-trace', now() - interval '1 hour')
  `, [deployment.id]);
  await pool.query(`
    INSERT INTO strategy_paper_positions (
      id, deployment_id, side, status, quantity, entry_price, opened_cycle_id, opened_at
    ) VALUES ('short-position', $1, 'short', 'open', 2, 100, 'funding-cycle', now() - interval '1 hour')
  `, [deployment.id]);
  const fundingTime = Date.now();
  const first = await applyPaperFundingRates(pool, {
    deploymentId: deployment.id,
    rates: [{ time: fundingTime, rate: 0.001 }],
  });
  const repeated = await applyPaperFundingRates(pool, {
    deploymentId: deployment.id,
    rates: [{ time: fundingTime, rate: 0.001 }],
  });
  assert.equal(first.applied, 1);
  assert.equal(first.fundingCostUsdt, -0.2);
  assert.equal(repeated.applied, 0);
  assert.equal(Number((await pool.query("SELECT funding_usdt FROM strategy_paper_positions WHERE id = 'short-position'")).rows[0].funding_usdt), -0.2);
});

test("official contract follows through account-free spot runtime into its isolated 10k paper portfolio", async () => {
  const portfolios = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const portfolio = portfolios.find((item) => item.strategyCode === "ai_conservative");
  const deployment = await createStrategyDeployment(pool, {
    ownerUserId: "owner-official",
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode: "paper",
    validationLabel: "UNVERIFIED",
    idempotencyKey: "official-spot-paper",
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: "ai_conservative",
    membershipId: "membership-official",
    paperPortfolioId: portfolio.id,
  });
  let rows = officialEntryCandles();
  let marketRows = [...rows, {
    ...rows.at(-1),
    openTime: rows.at(-1).closeTime + 1,
    closeTime: rows.at(-1).closeTime + 3_600_000,
  }];
  const spotAdapter = {
    async getCandles() { return { items: marketRows, provider: "fixture" }; },
    async getFeeSchedule() { return { makerRate: 0.001, takerRate: 0.001, source: "fixture" }; },
  };
  const dependencies = {
    createSpotAdapter: () => spotAdapter,
    saveSnapshot: async (_database, input) => ({ id: input.sourceId, candleSha256: "a", fundingSha256: "b", datasetSha256: "c" }),
  };
  const firstNow = new Date(rows.at(-1).closeTime + 1_000);
  const firstLease = await leaseNextStrategyDeployment(pool, { workerId: "official-runtime-a", now: firstNow, leaseSeconds: 30 });
  assert.equal(firstLease.id, deployment.id);
  assert.equal(firstLease.exchangeAccountId, null);
  assert.equal(firstLease.executionProduct, "spot_usdt");
  const first = await processLeasedStrategyRuntimeDeployment(pool, firstLease, "official-runtime-a", { ...dependencies, now: () => firstNow });
  assert.equal(first.decision.action, "enter_long");
  const firstCycle = await pool.query("SELECT candle_close_time FROM strategy_runtime_cycles WHERE id = $1", [first.cycleId]);
  assert.equal(new Date(firstCycle.rows[0].candle_close_time).getTime(), rows.at(-1).closeTime,
    "当前未收盘尾项不得成为决策轮");
  assert.equal((await pool.query("SELECT status FROM official_paper_order_intents")).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_paper_order_intents")).rows[0].count, 0);

  const last = rows.at(-1);
  rows = [...rows, {
    openTime: last.closeTime + 1,
    closeTime: last.closeTime + 3_600_000,
    open: last.close,
    high: last.close * 1.002,
    low: last.close * 0.998,
    close: last.close,
    volume: 100,
  }];
  marketRows = [...rows, {
    ...rows.at(-1),
    openTime: rows.at(-1).closeTime + 1,
    closeTime: rows.at(-1).closeTime + 3_600_000,
  }];
  const secondNow = new Date(rows.at(-1).closeTime + 1_000);
  const secondLease = await leaseNextStrategyDeployment(pool, { workerId: "official-runtime-b", now: secondNow, leaseSeconds: 30 });
  await processLeasedStrategyRuntimeDeployment(pool, secondLease, "official-runtime-b", { ...dependencies, now: () => secondNow });
  const storedPortfolio = (await pool.query(`
    SELECT principal_usdt, cash_usdt FROM official_paper_portfolios WHERE id = $1
  `, [portfolio.id])).rows[0];
  assert.equal(Number(storedPortfolio.principal_usdt), 10_000);
  assert.ok(Number(storedPortfolio.cash_usdt) < 10_000);
  assert.equal((await pool.query("SELECT side FROM official_paper_positions WHERE portfolio_id = $1 AND status = 'open'", [portfolio.id])).rows[0].side, "long");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_paper_funding_accruals WHERE deployment_id = $1", [deployment.id])).rows[0].count, 0);
  const riskState = (await pool.query("SELECT risk_state_json FROM strategy_deployments WHERE id = $1", [deployment.id])).rows[0].risk_state_json;
  assert.ok(riskState.dailyLossPct > 0);
  assert.ok(riskState.maxDrawdownPct >= riskState.drawdownPct && riskState.maxDrawdownPct > 0);
});

test("同一张卡的两个客户共享同一行决策轮，各自保留自己的周期", async () => {
  // ADR-0018 的核心：判断共享，准入按组合。5,000 会员 × 3 张卡会有 15,000 个部署，
  // 而三张卡合计只有 6 种 (品种,周期) 组合——不共享就是同一段结论和同一次 LLM
  // 解释被生成上万次。
  // 解释任务需要模型绑定。自己种，不依赖其它测试的执行顺序。
  await pool.query(`
    INSERT INTO llm_profiles (
      id, name, provider_name, base_url, model_name, encrypted_api_key,
      enabled, current_revision_id, created_by_user_id, updated_by_user_id
    ) VALUES ('shared-profile', 'Shared', 'Private', 'https://llm.example.com/v1',
              'shared-model', 'encrypted', true, 'shared-revision', 'admin', 'admin')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO llm_profile_revisions (
      id, profile_id, revision_number, name, provider_name, base_url,
      model_name, encrypted_api_key, enabled, created_by_user_id
    ) VALUES ('shared-revision', 'shared-profile', 1, 'Shared', 'Private',
              'https://llm.example.com/v1', 'shared-model', 'encrypted', true, 'admin')
    ON CONFLICT (id) DO NOTHING
  `);
  for (const role of ["market_summary", "adversarial_explanation", "risk_explanation"]) {
    await pool.query(`
      INSERT INTO runtime_explanation_bindings (id, role, llm_profile_id, enabled, updated_by_user_id)
      VALUES ($1, $2, 'shared-profile', true, 'admin')
      ON CONFLICT (role) DO UPDATE SET enabled = true
    `, [`shared-binding-${role}`, role]);
  }

  await pool.query(`INSERT INTO users (id, organization_id) VALUES ('owner-shared-b', NULL)`);
  await pool.query(`INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
                    VALUES ('membership-shared-b', 'owner-shared-b', 'active', NULL, NULL)`);

  const makeDeployment = async (owner, membership, key) => {
    const portfolios = await ensureOfficialPaperPortfolios(pool, { membershipId: membership, customerId: owner });
    const portfolio = portfolios.find((item) => item.strategyCode === "ai_conservative");
    return createStrategyDeployment(pool, {
      ownerUserId: owner,
      strategyId: "strategy-official",
      strategyVersionId: "version-official",
      exchangeAccountId: null,
      mode: "paper",
      validationLabel: "UNVERIFIED",
      idempotencyKey: key,
      riskAcknowledged: true,
      executionProduct: "spot_usdt",
      platformStrategyCode: "ai_conservative",
      membershipId: membership,
      paperPortfolioId: portfolio.id,
    });
  };

  const a = await makeDeployment("owner-shared-a", "membership-shared-a", "shared-a");
  const b = await makeDeployment("owner-shared-b", "membership-shared-b", "shared-b");

  // 用自己的 K 线窗口：决策轮的身份是 (卡, 品种, 周期, K线收盘时间)，
  // 与更早的测试共用 fixture 会撞进同一轮，那时去重生效、本测试反而看不到事件。
  const snapshotSourceIds = [];
  const shift = 90 * 24 * 3_600_000;
  const rows = officialEntryCandles().map((candle) => ({
    ...candle,
    openTime: candle.openTime + shift,
    closeTime: candle.closeTime + shift,
  }));
  const dependencies = {
    createSpotAdapter: () => ({
      async getCandles() { return { items: rows, provider: "fixture" }; },
      async getFeeSchedule() { return { makerRate: 0.001, takerRate: 0.001, source: "fixture" }; },
    }),
    saveSnapshot: async (_database, input) => {
      snapshotSourceIds.push(input.sourceId);
      return { id: input.sourceId, candleSha256: "a", fundingSha256: "b", datasetSha256: "c" };
    },
  };

  for (const [index, deployment] of [a, b].entries()) {
    const now = new Date(rows.at(-1).closeTime + 1_000 + index * 20_000);
    const lease = await leaseNextStrategyDeployment(pool, { workerId: `shared-${index}`, now, leaseSeconds: 30 });
    assert.equal(lease.id, deployment.id, "本测试假定两个部署按顺序被租走");
    await processLeasedStrategyRuntimeDeployment(pool, lease, `shared-${index}`, { ...dependencies, now: () => now });
  }

  const candleClose = rows.at(-1).closeTime;
  const rounds = await pool.query(`
    SELECT id, strategy_code, symbol, timeframe, decision_json
    FROM strategy_decision_rounds
    WHERE strategy_code = 'ai_conservative' AND candle_close_time = to_timestamp($1 / 1000.0)
  `, [candleClose]);
  assert.equal(rounds.rows.length, 1, "同一张卡在同一根 K 线上只应有一行决策轮");
  const roundId = rounds.rows[0].id;
  assert.equal(rounds.rows[0].symbol, "BTCUSDT");

  // 两个部署各自的周期都挂在这一行上。
  const cycles = await pool.query(`
    SELECT deployment_id FROM strategy_runtime_cycles
    WHERE decision_round_id = $1 ORDER BY deployment_id
  `, [roundId]);
  assert.deepEqual(cycles.rows.map((row) => row.deployment_id).sort(), [a.id, b.id].sort());

  // 七阶段事件也挂上了——它们属于共享单元，不该逐客户复制一份叙述。
  const events = await pool.query(`
    SELECT count(*)::int AS count FROM strategy_runtime_events WHERE decision_round_id = $1
  `, [roundId]);
  // 七阶段叙述属于共享单元：一轮只写一套，不随订阅人数增长。
  // 5,000 会员 × 3 张卡下这是 105,000 行降到 7 行。
  assert.equal(events.rows[0].count, 7, "同一决策轮只应有一套七阶段事件");

  // 共享轮里不得出现任何客户的风控读数。
  //
  // risk 阶段的 evidence 带 riskState（回撤、当日亏损、连续亏损、熔断）。
  // 决策轮展示给该卡的所有客户——若它是用某位客户的状态算出来的，就等于把那位
  // 客户的财务状况给别人看。卡级结论必须用中性风控状态算（ADR-0018「阶段 5 有两半」）。
  const riskEvent = (await pool.query(`
    SELECT evidence_json FROM strategy_runtime_events
    WHERE decision_round_id = $1 AND role = 'risk'
  `, [roundId])).rows[0];
  assert.ok(riskEvent, "共享轮应当有 risk 阶段事件");
  const sharedRiskState = riskEvent.evidence_json.riskState;
  assert.deepEqual(
    {
      drawdownPct: sharedRiskState.drawdownPct,
      dailyLossPct: sharedRiskState.dailyLossPct,
      consecutiveLosses: sharedRiskState.consecutiveLosses,
      halted: sharedRiskState.halted,
      unavailableFields: sharedRiskState.unavailableFields,
    },
    { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false, unavailableFields: [] },
    "共享轮的 risk 证据必须是中性状态，不能带某个客户的实际读数",
  );

  // 行情快照同理：同卡同品种同 K 线是同一份数据。两个部署都用决策轮作为
  // sourceId，saveMarketDataSnapshot 的 ON CONFLICT (source_type, source_id)
  // 会把第二次写入折叠掉——15,000 行降到 1 行。
  assert.deepEqual([...new Set(snapshotSourceIds)], [roundId],
    "两个部署都应当以决策轮作为快照 sourceId");

  // 这才是省钱的那条：同一张卡在同一根 K 线上的解释内容完全相同（它解释的是
  // 卡级结论，不含任何客户数据），所以每轮每角色只允许一个 LLM 任务。
  // 不共享的话 5,000 会员就是同一段解释被生成上万次。
  const jobs = await pool.query(`
    SELECT event_role, count(*)::int AS count
    FROM strategy_runtime_explanation_jobs
    WHERE decision_round_id = $1 GROUP BY event_role
  `, [roundId]);
  assert.ok(jobs.rows.length > 0, "入场决策应当触发解释任务");
  for (const row of jobs.rows) {
    assert.equal(row.count, 1, `${row.event_role} 每轮只应有一个解释任务，实际 ${row.count}`);
  }

  // 一次调用的结果必须写回该轮下**所有**部署的事件，否则第二个客户看到空白。
  //
  // 不假设租约顺序：同一个 schema 里更早的测试可能留下 pending 任务，
  // leaseNextRuntimeExplanationJob 是全局取下一个。这里排干队列再断言结果。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const leased = await leaseNextRuntimeExplanationJob(pool, { workerId: `explain-${attempt}`, now: new Date(), leaseSeconds: 30 });
    if (!leased) break;
    await completeRuntimeExplanationJob(pool, {
      jobId: leased.id,
      workerId: `explain-${attempt}`,
      fencingToken: leased.fencingToken,
      output: { summary: "共享决策轮的解释", bullets: ["a"], caveats: ["b"] },
      modelName: "fixture-model",
      durationMs: 5,
    });
  }
  // 只断言真正建了任务的角色：其余角色的 explanation_status 是
  // 'not_requested'，那是正常默认值，不是缺失。
  // 事件挂在决策轮上，cycle_id 可空（纯 hold 不写周期），因此不能用 JOIN 取。
  const explained = await pool.query(`
    SELECT event.role, event.explanation_status
    FROM strategy_runtime_events AS event
    WHERE event.decision_round_id = $1
      AND event.role IN (
        SELECT event_role FROM strategy_runtime_explanation_jobs WHERE decision_round_id = $1
      )
  `, [roundId]);
  assert.ok(explained.rows.length > 0, "该轮应当有事件收到解释状态");
  const byRole = new Map();
  for (const row of explained.rows) {
    byRole.set(row.role, [...(byRole.get(row.role) ?? []), row]);
  }
  for (const [role, rows] of byRole) {
    // 事件收敛后每轮每角色只有一行，一次 LLM 调用写回它即可。
    assert.equal(rows.length, 1, `${role} 每轮只应有一行事件`);
    assert.equal(rows[0].explanation_status, "completed", `${role} 事件没有收到解释`);
  }
});

test("performance fee scope is derived server-side from the complete official three-card portfolio set", async () => {
  const membershipId = "membership-performance-scope";
  const customerId = "owner-performance-scope";
  await pool.query(`
    INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
    VALUES ($1, $2, 'active', NULL, NULL)
  `, [membershipId, customerId]);
  await ensureOfficialPaperPortfolios(pool, { membershipId, customerId });

  const scope = await resolveOfficialThreeCardPortfolioScope(pool, { membershipId, customerId });
  assert.deepEqual(scope, {
    customerId,
    membershipId,
    book: "paper",
    scopeKey: `official-three:${membershipId}`,
    strategies: [
      { strategyCode: "ai_conservative", portfolioId: `official-paper:${membershipId}:ai_conservative` },
      { strategyCode: "ai_balanced", portfolioId: `official-paper:${membershipId}:ai_balanced` },
      { strategyCode: "ai_aggressive", portfolioId: `official-paper:${membershipId}:ai_aggressive` },
    ],
    portfolioIds: [
      `official-paper:${membershipId}:ai_conservative`,
      `official-paper:${membershipId}:ai_balanced`,
      `official-paper:${membershipId}:ai_aggressive`,
    ],
  });

  // 客户上实盘后，这个会员名下会多出一本实盘账。计费范围此前查的是「名下全部组合」
  // 并断言恰好三个——多出一本就会让这个客户的绩效计费整个停掉，
  // 而报错信息是「官方三卡组合不完整」，完全指不到真正的原因。
  await pool.query(`
    INSERT INTO official_paper_portfolios
      (id, membership_id, customer_id, strategy_code, book, principal_usdt, cash_usdt, risk_json, exchange_account_id)
    VALUES ($1, $2, $3, 'ai_balanced', 'live', 3000, 3000, '{}'::jsonb, 'acct-live-1')
  `, [`official-live:${membershipId}:ai_balanced`, membershipId, customerId]);

  const stillPaper = await resolveOfficialThreeCardPortfolioScope(pool, { membershipId, customerId });
  assert.deepEqual(stillPaper.portfolioIds, scope.portfolioIds, "实盘账不得进入模拟盘的计费范围");

  // 实盘不要求三张卡齐全：客户按自己的节奏逐张上实盘。
  const liveScope = await resolveOfficialThreeCardPortfolioScope(pool, { membershipId, customerId, book: "live" });
  assert.deepEqual(liveScope.portfolioIds, [`official-live:${membershipId}:ai_balanced`]);
  assert.equal(liveScope.scopeKey, `official-live:${membershipId}`, "两本账的计费范围键必须不同");

  const incompleteMembershipId = "membership-performance-scope-incomplete";
  await pool.query(`
    INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
    VALUES ($1, $2, 'active', NULL, NULL)
  `, [incompleteMembershipId, customerId]);
  await pool.query(`
    INSERT INTO official_paper_portfolios (
      id, membership_id, customer_id, strategy_code, risk_json
    ) VALUES ($1, $2, $3, 'ai_conservative', '{}'::jsonb)
  `, [
    `official-paper:${incompleteMembershipId}:ai_conservative`,
    incompleteMembershipId,
    customerId,
  ]);
  await assert.rejects(
    resolveOfficialThreeCardPortfolioScope(pool, { membershipId: incompleteMembershipId, customerId }),
    /官方三卡组合不完整/,
  );
});

test("official paper provisioning rejects a customer that does not own the membership", async () => {
  const membershipId = "membership-owned";
  await pool.query(`
    INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
    VALUES ($1, 'owner-membership', 'active', NULL, NULL)
  `, [membershipId]);
  await assert.rejects(
    ensureOfficialPaperPortfolios(pool, { membershipId, customerId: "different-customer" }),
    /会员.*客户|归属/,
  );
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM official_paper_portfolios WHERE membership_id = $1
  `, [membershipId])).rows[0].count, 0);
});

test("one customer/card has one active deployment and mode switches fail closed with an official position", async () => {
  const [portfolio] = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const deployment = await createStrategyDeployment(pool, {
    ownerUserId: "owner-official",
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode: "paper",
    validationLabel: "UNVERIFIED",
    idempotencyKey: "official-one-active-paper",
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: portfolio.strategyCode,
    membershipId: portfolio.membershipId,
    paperPortfolioId: portfolio.id,
  });
  assert.deepEqual(await endConflictingOfficialStrategyDeployments(pool, {
    ownerUserId: "owner-official",
    strategyCode: portfolio.strategyCode,
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    mode: "paper",
    paperPortfolioId: portfolio.id,
  }), { endedDeploymentIds: [], endedSubscriptionIds: [] });

  await pool.query("UPDATE strategy_deployments SET status = 'paused' WHERE id = $1", [deployment.id]);
  await assert.rejects(
    changeStrategyDeploymentStatus(pool, {
      deploymentId: deployment.id,
      ownerUserId: "owner-official",
      action: "resume",
    }),
    /官方策略|恢复/,
  );

  await pool.query(`
    INSERT INTO official_paper_positions (
      id, portfolio_id, symbol, side, status, quantity, average_entry_price,
      cost_basis_usdt, last_mark_price, opened_at
    ) VALUES ('mode-switch-position', $1, 'BTCUSDT', 'long', 'open', 0.01, 50000, 500, 50000, now())
  `, [portfolio.id]);
  await assert.rejects(
    endConflictingOfficialStrategyDeployments(pool, {
      ownerUserId: "owner-official",
      strategyCode: portfolio.strategyCode,
      strategyId: "strategy-official",
      strategyVersionId: "version-official",
      mode: "shadow",
      paperPortfolioId: portfolio.id,
    }),
    (error) => error instanceof OfficialStrategyModeSwitchOpenPositionError,
  );
  await pool.query("DELETE FROM official_paper_positions WHERE id = 'mode-switch-position'");
  const switched = await endConflictingOfficialStrategyDeployments(pool, {
    ownerUserId: "owner-official",
    strategyCode: portfolio.strategyCode,
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    mode: "shadow",
    paperPortfolioId: portfolio.id,
  });
  assert.deepEqual(switched.endedDeploymentIds, [deployment.id]);
  assert.equal((await pool.query("SELECT status FROM strategy_deployments WHERE id = $1", [deployment.id])).rows[0].status, "ended");
});

test("generic resume cannot reactivate an official deployment paused between its check and update", async () => {
  const [portfolio] = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const deployment = await createStrategyDeployment(pool, {
    ownerUserId: "owner-official",
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode: "paper",
    validationLabel: "UNVERIFIED",
    idempotencyKey: "official-resume-interleaving",
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: portfolio.strategyCode,
    membershipId: portfolio.membershipId,
    paperPortfolioId: portfolio.id,
  });
  let pauseInterleaved = false;
  const interleavedDatabase = {
    async query(text, values) {
      if (!pauseInterleaved && /^\s*UPDATE strategy_deployments/.test(text) && /SET status = \$3/.test(text)) {
        await pool.query("UPDATE strategy_deployments SET status = 'paused' WHERE id = $1", [deployment.id]);
        pauseInterleaved = true;
      }
      const result = await pool.query(text, values);
      if (!pauseInterleaved && /SELECT execution_product FROM strategy_deployments/.test(text)) {
        await pool.query("UPDATE strategy_deployments SET status = 'paused' WHERE id = $1", [deployment.id]);
        pauseInterleaved = true;
      }
      return result;
    },
  };

  await assert.rejects(
    changeStrategyDeploymentStatus(interleavedDatabase, {
      deploymentId: deployment.id,
      ownerUserId: "owner-official",
      action: "resume",
    }),
    (error) => error instanceof OfficialStrategyGenericResumeBlockedError,
  );
  assert.equal(pauseInterleaved, true);
  assert.equal((await pool.query(
    "SELECT status FROM strategy_deployments WHERE id = $1",
    [deployment.id],
  )).rows[0].status, "paused");
});

test("official deployment ownership is bound to the same customer membership portfolio triple", async () => {
  await pool.query(`
    INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
    VALUES ('membership-owner-b', 'owner-b', 'active', NULL, NULL)
  `);
  const [portfolioB] = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-owner-b",
    customerId: "owner-b",
  });
  await assert.rejects(createStrategyDeployment(pool, {
    ownerUserId: "owner-official",
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode: "paper",
    validationLabel: "UNVERIFIED",
    idempotencyKey: "official-cross-owner-rejected",
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: portfolioB.strategyCode,
    membershipId: portfolioB.membershipId,
    paperPortfolioId: portfolioB.id,
  }), /归属|组合/);
  await assert.rejects(pool.query(`
    INSERT INTO strategy_deployments (
      id, owner_user_id, strategy_id, strategy_version_id, exchange_account_id,
      mode, validation_label, idempotency_key, execution_product,
      platform_strategy_code, membership_id, paper_portfolio_id
    ) VALUES (
      'official-cross-owner-direct', 'owner-official', 'strategy-official', 'version-official', NULL,
      'paper', 'UNVERIFIED', 'official-cross-owner-direct', 'spot_usdt',
      $1, $2, $3
    )
  `, [portfolioB.strategyCode, portfolioB.membershipId, portfolioB.id]), /foreign key|violates/i);
});

test("official deployment strategy code is bound to the portfolio strategy code after 0024 reapply", async () => {
  const portfolios = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const conservative = portfolios.find((portfolio) => portfolio.strategyCode === "ai_conservative");
  assert.ok(conservative);
  await assert.rejects(pool.query(`
    INSERT INTO strategy_deployments (
      id, owner_user_id, strategy_id, strategy_version_id, exchange_account_id,
      mode, validation_label, idempotency_key, execution_product,
      platform_strategy_code, membership_id, paper_portfolio_id
    ) VALUES (
      'official-cross-strategy-direct', 'owner-official', 'strategy-official', 'version-official', NULL,
      'paper', 'UNVERIFIED', 'official-cross-strategy-direct', 'spot_usdt',
      'ai_aggressive', $1, $2
    )
  `, [conservative.membershipId, conservative.id]), /foreign key|violates/i);
});

test("0024 upgrades a historical pre-column deployment and reapplies", async () => {
  const historicalSchema = `${schema}_historical`;
  const historicalPool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${historicalSchema}`,
  });
  try {
    await adminPool.query(`CREATE SCHEMA "${historicalSchema}"`);
    await initializePre0024Schema(historicalPool);
    await historicalPool.query(`
      INSERT INTO strategy_deployments(
        id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,
        mode,validation_label,idempotency_key
      ) VALUES(
        'historical-n-minus-one','historical-owner','historical-strategy',
        'historical-version','historical-account','paper','UNVERIFIED',
        'historical-n-minus-one'
      )
    `);
    const migration = await readFile(
      new URL("../postgres/migrations/0024_platform_demo_execution.sql", import.meta.url),
      "utf8",
    );
    await historicalPool.query(migration);
    await historicalPool.query(migration);
    assert.equal((await historicalPool.query(`
      SELECT exchange_account_id IS NOT NULL
          AND execution_product='usdt_perpetual'
          AND platform_strategy_code IS NULL
          AND membership_id IS NULL
          AND paper_portfolio_id IS NULL AS valid
      FROM strategy_deployments WHERE id='historical-n-minus-one'
    `)).rows[0].valid, true);
  } finally {
    await historicalPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${historicalSchema}" CASCADE`);
  }
});

test("deployment binding columns allow only official 0111 and legacy 1000 across all 32 product masks", async () => {
  const portfolios = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const conservative = portfolios.find((portfolio) => portfolio.strategyCode === "ai_conservative");
  assert.ok(conservative);

  const insertDeployment = async ({ id, executionProduct, mask, missingPortfolio = false }) => pool.query(`
    INSERT INTO strategy_deployments (
      id, owner_user_id, strategy_id, strategy_version_id, exchange_account_id,
      mode, validation_label, idempotency_key, execution_product,
      platform_strategy_code, membership_id, paper_portfolio_id
    ) VALUES (
      $1, 'owner-official', 'strategy-official', 'version-official', $2,
      'paper', 'UNVERIFIED', $1, $3,
      $4, $5, $6
    )
  `, [
    id,
    mask & 0b1000 ? "account-a" : null,
    executionProduct,
    mask & 0b0100 ? conservative.strategyCode : null,
    mask & 0b0010 ? conservative.membershipId : null,
    mask & 0b0001 ? (missingPortfolio ? "portfolio-does-not-exist" : conservative.id) : null,
  ]);

  for (const executionProduct of ["spot_usdt", "usdt_perpetual"]) {
    for (let mask = 0; mask < 0b1_0000; mask += 1) {
      const allowed = executionProduct === "spot_usdt" ? 0b0111 : 0b1000;
      const attempt = insertDeployment({
        id: `${executionProduct}-binding-${mask}`,
        executionProduct,
        mask,
      });
      if (mask === allowed) await attempt;
      else await assert.rejects(
        attempt,
        /check constraint|violates/i,
        `${executionProduct} mask ${mask.toString(2).padStart(4, "0")} must fail closed`,
      );
    }
  }

  await assert.rejects(
    createStrategyDeployment(pool, {
      ownerUserId: "owner-official",
      strategyId: "strategy-a",
      strategyVersionId: "version-a",
      exchangeAccountId: null,
      mode: "paper",
      validationLabel: "UNVERIFIED",
      idempotencyKey: "legacy-missing-exchange-account",
      riskAcknowledged: true,
    }),
    /交易账户|exchange/i,
  );
});

test("official complete binding with an unknown portfolio reaches the foreign key", async () => {
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_deployments(
        id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,
        mode,validation_label,idempotency_key,execution_product,
        platform_strategy_code,membership_id,paper_portfolio_id
      ) VALUES(
        'official-unknown-portfolio','owner-official','strategy-official',
        'version-official',NULL,'paper','UNVERIFIED','official-unknown-portfolio',
        'spot_usdt','ai_conservative','membership-official','unknown-portfolio'
      )
    `),
    (error) => error.code === "23503"
      && /strategy_deployments_official_portfolio_(owner|strategy)_fk/.test(error.constraint),
  );
});

test("0024 upgrades the immediate weaker N-1 binding check and reapplies", async () => {
  await pool.query(`
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,
      mode,validation_label,idempotency_key
    ) VALUES(
      'immediate-n-minus-one','legacy-owner','legacy-strategy','legacy-version',
      'account-a','paper','UNVERIFIED','immediate-n-minus-one'
    );
    ALTER TABLE strategy_deployments
      DROP CONSTRAINT strategy_deployments_official_binding_check;
    ALTER TABLE strategy_deployments
      ADD CONSTRAINT strategy_deployments_official_binding_check
      CHECK (
        execution_product <> 'spot_usdt'
        OR (paper_portfolio_id IS NOT NULL AND membership_id IS NOT NULL
            AND platform_strategy_code IS NOT NULL AND exchange_account_id IS NULL)
      );
  `);
  const migration = await readFile(
    new URL("../postgres/migrations/0024_platform_demo_execution.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await pool.query(`
    SELECT exchange_account_id IS NOT NULL
        AND platform_strategy_code IS NULL
        AND membership_id IS NULL
        AND paper_portfolio_id IS NULL AS valid
    FROM strategy_deployments WHERE id='immediate-n-minus-one'
  `)).rows[0].valid, true);
});

test("pending official paper settlement locks current membership access and expired access permits only sells", async () => {
  const membershipId = "membership-settlement-access";
  const customerId = "owner-settlement-access";
  await pool.query(`
    INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
    VALUES ($1, $2, 'active', NULL, NULL)
  `, [membershipId, customerId]);
  const portfolio = (await ensureOfficialPaperPortfolios(pool, { membershipId, customerId }))[0];
  const deployment = await createStrategyDeployment(pool, {
    ownerUserId: customerId,
    strategyId: "strategy-official",
    strategyVersionId: "version-official",
    exchangeAccountId: null,
    mode: "paper",
    validationLabel: "UNVERIFIED",
    idempotencyKey: "official-settlement-access",
    riskAcknowledged: true,
    executionProduct: "spot_usdt",
    platformStrategyCode: portfolio.strategyCode,
    membershipId,
    paperPortfolioId: portfolio.id,
  });
  const insertPending = async (sequence, action, payload = {}, cycleAt = `2026-08-2${sequence}T00:00:00.000Z`) => {
    const cycleId = `settlement-access-cycle-${sequence}`;
    await pool.query(`
      INSERT INTO strategy_runtime_cycles (
        id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
        status, decision_json, trace_id, started_at
      ) VALUES ($1, $2, $3, 1, $4, $4, 'completed', '{}'::jsonb, $5, $4)
    `, [cycleId, deployment.id, sequence, new Date(cycleAt), `trace-${sequence}`]);
    await pool.query(`
      INSERT INTO official_paper_order_intents (
        id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
        symbol, action, execution_timing, requested_price, status, payload_json
      ) VALUES ($1, $2, $3, $4, $5, 'BTCUSDT', $6, 'next_candle_open', 50000, 'pending', $7::jsonb)
    `, [crypto.randomUUID(), portfolio.id, deployment.id, cycleId, `settlement-access-${sequence}`, action,
      JSON.stringify({ quoteAmountUsdt: 100, takerFeeRate: 0.001, ...payload })]);
  };

  await insertPending(1, "buy", {}, "2026-08-16T00:00:00.000Z");
  assert.equal((await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date("2026-08-16T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-active-buy",
  }))?.status, "filled");
  await pool.query(`
    UPDATE memberships
    SET status = 'expired', expires_at = '2026-08-21T00:00:00.000Z', grace_ends_at = '2026-08-21T00:00:00.000Z'
    WHERE id = $1
  `, [membershipId]);
  await insertPending(2, "sell", { quantity: 0.001 });
  assert.equal((await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 51_000,
    fillTime: new Date("2026-08-22T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-expired-sell",
  }))?.status, "filled");
  const partialPosition = (await pool.query(`
    SELECT quantity, entry_fees_usdt FROM official_paper_positions
    WHERE portfolio_id = $1 AND status = 'open'
  `, [portfolio.id])).rows[0];
  assert.equal(Number(partialPosition.quantity), 0.001);
  assert.equal(Number(partialPosition.entry_fees_usdt), 0.05);
  await insertPending(3, "sell");
  assert.equal((await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 52_000,
    fillTime: new Date("2026-08-23T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-expired-final-sell",
  }))?.status, "filled");
  await insertPending(4, "buy");
  const expiredBuy = await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date("2026-08-24T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-expired-buy",
  });
  assert.equal(expiredBuy?.status, "rejected");
  assert.match(expiredBuy?.reason || "", /只允许平仓|只读/);
  assert.equal((await pool.query("SELECT access_status FROM official_paper_portfolios WHERE id = $1", [portfolio.id])).rows[0].access_status, "read_only");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_positions WHERE portfolio_id = $1 AND status = 'open'", [portfolio.id])).rows[0].count, 0);
  await pool.query(`
    UPDATE memberships
    SET status = 'pending', expires_at = '2099-01-01T00:00:00.000Z', grace_ends_at = '2099-01-02T00:00:00.000Z'
    WHERE id = $1
  `, [membershipId]);
  await insertPending(5, "buy");
  const pendingFutureBuy = await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date("2026-08-25T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-pending-future-buy",
  });
  assert.equal(pendingFutureBuy?.status, "rejected");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_positions WHERE portfolio_id = $1 AND status = 'open'", [portfolio.id])).rows[0].count, 0);
  const sellReceipts = (await pool.query(`
    SELECT realized_gross_pnl_usdt, realized_net_pnl_usdt, allocated_entry_fee_usdt
    FROM official_paper_fill_receipts
    WHERE portfolio_id = $1 AND action = 'sell'
    ORDER BY filled_at
  `, [portfolio.id])).rows;
  assert.deepEqual(sellReceipts.map((row) => Number(row.realized_gross_pnl_usdt)), [1, 2]);
  assert.deepEqual(sellReceipts.map((row) => Number(row.realized_net_pnl_usdt)), [0.899, 1.898]);
  assert.deepEqual(sellReceipts.map((row) => Number(row.allocated_entry_fee_usdt)), [0.05, 0.05]);

  const week = await aggregateOfficialThreeCardPreviousUtcWeek(pool, {
    membershipId,
    customerId,
    asOf: new Date("2026-08-24T12:00:00.000Z"),
  });
  assert.deepEqual(week.period, { start: "2026-08-17T00:00:00.000Z", end: "2026-08-24T00:00:00.000Z" });
  assert.equal(week.scopeVersion, "official-paper-closed-sells-v1");
  assert.equal(week.weekNetPnl, "2.797000000000");
  assert.equal(week.cumulativeNetPnl, "2.797000000000");
  assert.equal(week.priorNetPnl, "0.000000000000");
  assert.equal(week.realizedGrossPnlUsdt, "3.000000000000");
  assert.equal(week.realizedNetPnlUsdt, "2.797000000000");
  assert.equal(week.feesUsdt, "0.203000000000");
  await assert.rejects(
    pool.query("UPDATE official_paper_fill_receipts SET trace_id = 'mutated' WHERE portfolio_id = $1", [portfolio.id]),
    /append-only/i,
  );
});

test("emergency access is sticky across membership refresh while exits remain settleable", async () => {
  const deployment = await seedOfficialDeployment("paper", "official-emergency-settlement");
  const portfolioId = deployment.paperPortfolioId;
  const insertPending = async (sequence, action, payload = {}) => {
    const cycleId = `emergency-settlement-cycle-${sequence}`;
    const cycleAt = new Date(`2026-08-${String(10 + sequence).padStart(2, "0")}T00:00:00.000Z`);
    await pool.query(`
      INSERT INTO strategy_runtime_cycles (
        id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
        status, decision_json, trace_id, started_at
      ) VALUES ($1, $2, $3, 1, $4, $4, 'completed', '{}'::jsonb, $5, $4)
    `, [cycleId, deployment.id, sequence, cycleAt, `emergency-trace-${sequence}`]);
    await pool.query(`
      INSERT INTO official_paper_order_intents (
        id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
        symbol, action, execution_timing, requested_price, status, payload_json
      ) VALUES ($1, $2, $3, $4, $5, 'BTCUSDT', $6, 'next_candle_open', 50000, 'pending', $7::jsonb)
    `, [crypto.randomUUID(), portfolioId, deployment.id, cycleId, `emergency-intent-${sequence}`, action,
      JSON.stringify({ quoteAmountUsdt: 100, takerFeeRate: 0.001, ...payload })]);
  };
  const settle = (sequence) => settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date(`2026-08-${String(10 + sequence).padStart(2, "0")}T00:00:00.000Z`),
    timing: "next_candle_open",
    traceId: `emergency-settle-${sequence}`,
  });

  await insertPending(1, "buy");
  assert.equal((await settle(1))?.status, "filled");
  await insertPending(2, "buy");
  await insertPending(3, "sell");
  const pauseClient = await pool.connect();
  try {
    await pauseClient.query("BEGIN");
    const pauseBackendPid = (await pauseClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await pauseClient.query(`
      INSERT INTO trading_emergency_stops(id,scope_key,active)
      VALUES('platform-emergency','platform',true)
    `);
    const restricted = await restrictOfficialPaperPortfoliosForEmergency(pauseClient, {
      customerIds: ["owner-official"],
      now: new Date("2026-08-12T00:00:00.000Z"),
    });
    assert.equal(restricted.rejectedPendingBuys, 1);
    assert.deepEqual((await pauseClient.query(`
      SELECT action,status,rejection_code FROM official_paper_order_intents
      WHERE idempotency_key IN ('emergency-intent-2','emergency-intent-3')
      ORDER BY action
    `)).rows, [
      { action: "buy", status: "rejected", rejection_code: "TRADING_EMERGENCY_STOPPED" },
      { action: "sell", status: "pending", rejection_code: null },
    ]);
    const pendingExitSettlement = settle(3);
    let settlementBlockedByPause = false;
    for (let attempt = 0; attempt < 100 && !settlementBlockedByPause; attempt += 1) {
      const blocked = await pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid))
        ) AS present
      `, [pauseBackendPid]);
      settlementBlockedByPause = blocked.rows[0].present === true;
      if (!settlementBlockedByPause) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(settlementBlockedByPause, true);
    await pauseClient.query("COMMIT");
    assert.equal((await pendingExitSettlement)?.status, "filled");
  } catch (error) {
    await pauseClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    pauseClient.release();
  }
  assert.equal((await pool.query(
    "SELECT access_status FROM official_paper_portfolios WHERE id=$1",
    [portfolioId],
  )).rows[0].access_status, "read_only");

  await insertPending(4, "buy");
  const stoppedBuy = await settle(4);
  assert.equal(stoppedBuy?.status, "rejected");
  assert.match(stoppedBuy?.reason || "", /只允许平仓|只读|紧急暂停/);
  assert.equal((await pool.query(`
    SELECT rejection_code FROM official_paper_order_intents
    WHERE idempotency_key='emergency-intent-4'
  `)).rows[0].rejection_code, "TRADING_EMERGENCY_STOPPED");

  await pool.query(`UPDATE trading_emergency_stops SET active=false WHERE scope_key='platform'`);
  await insertPending(5, "buy");
  const stillRestrictedBuy = await settle(5);
  assert.equal(stillRestrictedBuy?.status, "rejected");
  assert.equal((await pool.query(
    "SELECT access_status FROM official_paper_portfolios WHERE id=$1",
    [portfolioId],
  )).rows[0].access_status, "read_only");
});

test("a buy completed after emergency pause during a lease is rejected", async () => {
  const deployment = await seedOfficialDeployment("paper", "official-emergency-during-lease");
  const leasedAt = new Date(Date.now() + 60_000);
  const lease = await leaseNextStrategyDeployment(pool, {
    workerId: "emergency-race-worker",
    now: leasedAt,
    leaseSeconds: 30,
  });
  assert.equal(lease.id, deployment.id);
  const events = [
    "market_data", "technical_analysis", "strategy_decision", "adversarial_review",
    "risk", "decision", "execution",
  ].map((role, index) => ({
    sequence: index + 1,
    role,
    conclusion: role,
    evidence: {},
    durationMs: 0,
    llmUsed: false,
  }));
  const completionInput = {
    cycleId: "emergency-during-lease-cycle",
    deploymentId: deployment.id,
    workerId: "emergency-race-worker",
    fencingToken: lease.fencingToken,
    candleOpenTime: leasedAt,
    candleCloseTime: new Date(leasedAt.getTime() + 3_599_999),
    marketDataSnapshotId: "emergency-during-lease-snapshot",
    decision: { action: "enter_long" },
    orderIntent: {
      action: "enter_long",
      executionTiming: "next_candle_open",
      requestedPrice: null,
      idempotencyKey: "emergency-during-lease-intent",
      mode: "paper",
    },
    events,
    traceId: "emergency-during-lease-trace",
    startedAt: leasedAt,
    nextCycleAt: new Date(leasedAt.getTime() + 15_000),
    positionSizePct: 5,
    riskPerTradePct: 1,
    symbol: "BTCUSDT",
  };
  const pauseClient = await pool.connect();
  try {
    await pauseClient.query("BEGIN");
    const pauseBackendPid = (await pauseClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await pauseClient.query(`
      INSERT INTO trading_emergency_stops(id,scope_key,active)
      VALUES('platform-emergency-during-lease','platform',true)
    `);
    await restrictOfficialPaperPortfoliosForEmergency(pauseClient, {
      customerIds: ["owner-official"],
      now: leasedAt,
    });
    const completion = completeStrategyRuntimeCycle(pool, completionInput);
    let completionBlockedByPause = false;
    for (let attempt = 0; attempt < 100 && !completionBlockedByPause; attempt += 1) {
      const blocked = await pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid))
        ) AS present
      `, [pauseBackendPid]);
      completionBlockedByPause = blocked.rows[0].present === true;
      if (!completionBlockedByPause) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completionBlockedByPause, true);
    await pauseClient.query("COMMIT");
    await completion;
  } catch (error) {
    await pauseClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    pauseClient.release();
  }
  const intent = (await pool.query(`
    SELECT status,rejection_code FROM official_paper_order_intents
    WHERE idempotency_key='emergency-during-lease-intent'
  `)).rows[0];
  assert.deepEqual(intent, {
    status: "rejected",
    rejection_code: "TRADING_EMERGENCY_STOPPED",
  });
});

test("daily-loss halts reset on a new UTC day while persistent halt reasons remain", async () => {
  const [portfolio] = await ensureOfficialPaperPortfolios(pool, {
    membershipId: "membership-official",
    customerId: "owner-official",
  });
  const deployment = await createStrategyDeployment(pool, {
    ownerUserId: "owner-official", strategyId: "strategy-official", strategyVersionId: "version-official",
    exchangeAccountId: null, mode: "paper", validationLabel: "UNVERIFIED",
    idempotencyKey: "official-risk-halt-reasons", riskAcknowledged: true,
    executionProduct: "spot_usdt", platformStrategyCode: portfolio.strategyCode,
    membershipId: portfolio.membershipId, paperPortfolioId: portfolio.id,
  });
  await pool.query(`UPDATE official_paper_portfolios SET cash_usdt = 9700 WHERE id = $1`, [portfolio.id]);
  await pool.query(`UPDATE strategy_deployments SET risk_state_json = $2::jsonb WHERE id = $1`, [deployment.id, JSON.stringify({
    riskDayUtc: "2026-08-19", dailyBaselineEquityUsdt: 10000, equityUsdt: 9700,
    peakEquityUsdt: 10000, maxDrawdownPct: 1, halted: true, haltReasons: ["daily_loss"],
  })]);
  const reset = await refreshOfficialPaperRiskState(pool, {
    deploymentId: deployment.id, portfolioId: portfolio.id, asOf: new Date("2026-08-20T00:01:00.000Z"),
  });
  assert.equal(reset.halted, false);
  assert.deepEqual(reset.haltReasons, []);
  await pool.query(`UPDATE strategy_deployments SET risk_state_json = $2::jsonb WHERE id = $1`, [deployment.id, JSON.stringify({
    riskDayUtc: "2026-08-19", dailyBaselineEquityUsdt: 10000, equityUsdt: 9700,
    peakEquityUsdt: 10000, maxDrawdownPct: 1, halted: true, haltReasons: ["manual"],
  })]);
  const persistent = await refreshOfficialPaperRiskState(pool, {
    deploymentId: deployment.id, portfolioId: portfolio.id, asOf: new Date("2026-08-20T00:02:00.000Z"),
  });
  assert.equal(persistent.halted, true);
  assert.deepEqual(persistent.haltReasons, ["manual"]);
});

test("同一轮上出现两个行情源时拒绝新开仓，离场不受影响", async () => {
  // ADR-0025：官方卡统一用平台指定源。同一张卡上出现两个不同的 source policy
  // fingerprint 说明有代码或数据违反了这条边界，此时共享叙述会被拿去解释两份不同的
  // 行情。Worker 必须失败关闭，而不是悄悄让两个源共享一轮。
  clearRoundBindingCache();
  await pool.query(`INSERT INTO users (id, organization_id) VALUES ('owner-fork-a', NULL), ('owner-fork-b', NULL)`);
  await pool.query(`INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at)
                    VALUES ('membership-fork-a', 'owner-fork-a', 'active', NULL, NULL),
                           ('membership-fork-b', 'owner-fork-b', 'active', NULL, NULL)`);

  const makeDeployment = async (owner, membership, key) => {
    const portfolios = await ensureOfficialPaperPortfolios(pool, { membershipId: membership, customerId: owner });
    const portfolio = portfolios.find((item) => item.strategyCode === "ai_conservative");
    return createStrategyDeployment(pool, {
      ownerUserId: owner,
      strategyId: "strategy-official",
      strategyVersionId: "version-official",
      exchangeAccountId: null,
      mode: "paper",
      validationLabel: "UNVERIFIED",
      idempotencyKey: key,
      riskAcknowledged: true,
      executionProduct: "spot_usdt",
      platformStrategyCode: "ai_conservative",
      membershipId: membership,
      paperPortfolioId: portfolio.id,
    });
  };
  const a = await makeDeployment("owner-fork-a", "membership-fork-a", "binding-fork-a");
  const b = await makeDeployment("owner-fork-b", "membership-fork-b", "binding-fork-b");

  const pin = (id, deploymentId, ownerUserId, fingerprint, instance) => pool.query(`
    INSERT INTO strategy_market_source_bindings(
      id,deployment_id,owner_user_id,strategy_version_id,market_id,instrument_id,selection_mode,
      provider_id,provider_symbol,account_id,source_account_id,requested_usage,authorization_kind,
      capability_version_id,source_policy_fingerprint,binding_instance_fingerprint,pinning
    ) VALUES ($1,$2,$3,'version-official','crypto-global','BTCUSDT','independent',
      'exchange-binance','BTCUSDT',NULL,NULL,'research','public','capability-1',$4,$5,'pinned')
  `, [id, deploymentId, ownerUserId, fingerprint, instance]);
  await pin("fork-binding-a", a.id, "owner-fork-a", "a".repeat(64), "b".repeat(64));
  await pin("fork-binding-b", b.id, "owner-fork-b", "d".repeat(64), "e".repeat(64));

  const shift = 200 * 24 * 3_600_000;
  const rows = officialEntryCandles().map((candle) => ({
    ...candle, openTime: candle.openTime + shift, closeTime: candle.closeTime + shift,
  }));
  const dependencies = {
    createSpotAdapter: () => ({
      async getCandles() { return { items: rows, provider: "fixture" }; },
      async getFeeSchedule() { return { makerRate: 0.001, takerRate: 0.001, source: "fixture" }; },
    }),
    saveSnapshot: async (_database, input) => ({
      id: input.sourceId, candleSha256: "a", fundingSha256: "b", datasetSha256: "c",
    }),
  };

  const now = new Date(rows.at(-1).closeTime + 1_000);
  const lease = await leaseNextStrategyDeployment(pool, { workerId: "fork-worker", now, leaseSeconds: 30 });
  assert.ok([a.id, b.id].includes(lease.id), "本测试假定分叉的部署之一被租走");
  const processed = await processLeasedStrategyRuntimeDeployment(pool, lease, "fork-worker", {
    ...dependencies, now: () => now,
  });

  // 这批 K 线本来会触发开仓（同一份夹具在共享轮用例里产出 enter_long）。
  assert.equal(processed.decision.action, "enter_long");
  assert.equal(processed.decision.riskApproved, false, "分叉下不得批准开仓");
  assert.ok(processed.decision.rejectionReasons.includes("行情源绑定分叉，禁止新开仓"),
    `实际拒绝理由：${JSON.stringify(processed.decision.rejectionReasons)}`);

  const intents = await pool.query(
    "SELECT count(*)::int AS count FROM official_paper_order_intents WHERE deployment_id = $1", [lease.id],
  );
  assert.equal(intents.rows[0].count, 0, "分叉下不得产生开仓意图");
  clearRoundBindingCache();
});

test("PS-05：入队固定 Prompt 配置版本，随后的激活不改变这份任务", async () => {
  // 解释角色绑定是入队前提，自己种，不依赖其它测试的执行顺序。
  await pool.query(`
    INSERT INTO llm_profiles (
      id, name, provider_name, base_url, model_name, encrypted_api_key,
      enabled, current_revision_id, created_by_user_id, updated_by_user_id
    ) VALUES ('pin-profile','Pin','Private','https://llm.example.com/v1',
              'pin-model','encrypted',true,'pin-revision','admin','admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO llm_profile_revisions (
      id, profile_id, revision_number, name, provider_name, base_url,
      model_name, encrypted_api_key, enabled, created_by_user_id
    ) VALUES ('pin-revision','pin-profile',1,'Pin','Private','https://llm.example.com/v1',
              'pin-model','encrypted',true,'admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO runtime_explanation_bindings (id, role, llm_profile_id, enabled, updated_by_user_id)
    VALUES ('pin-binding-risk','risk_explanation','pin-profile',true,'admin')
    ON CONFLICT (role) DO UPDATE SET enabled = true, llm_profile_id = 'pin-profile';
  `);

  const version = async (id, instruction, number) => {
    const payload = JSON.stringify({ instruction });
    const sha = createHash("sha256").update(payload).digest("hex");
    await pool.query(`
      INSERT INTO configuration_versions (
        id, kind, configuration_key, audience, version_number, schema_version, payload_json, payload_sha256
      ) VALUES ($1,'prompt','runtime.risk_explanation','shared',$2,1,$3::jsonb,$4)
    `, [id, number, payload, sha]);
    await pool.query(
      "INSERT INTO configuration_activations (id, configuration_version_id, action) VALUES ($1,$2,'activate')",
      [`activation-${id}`, id]);
    return { id, sha, instruction };
  };

  const first = await version("pin-version-1", "第一版：解释风控边界为何允许或拒绝当前结论。", 1);
  const expectedPrompt = await resolveRuntimeExplanationPrompt("risk_explanation", first.instruction);

  const deployment = await seedOfficialDeployment("shadow");
  const now = new Date(Date.now() + 60_000);
  const lease = await leaseNextStrategyDeployment(pool, { workerId: "pin-runtime", now, leaseSeconds: 30 });
  const events = [
    "market_data", "technical_analysis", "strategy_decision", "adversarial_review",
    "risk", "decision", "execution",
  ].map((role, index) => ({
    sequence: index + 1, role, conclusion: `deterministic:${role}`, evidence: {}, durationMs: 1, llmUsed: false,
  }));
  await completeStrategyRuntimeCycle(pool, {
    cycleId: "cycle-pin", deploymentId: deployment.id, workerId: "pin-runtime", fencingToken: lease.fencingToken,
    candleOpenTime: new Date(0), candleCloseTime: new Date(3_599_999), marketDataSnapshotId: "snapshot-pin",
    decision: { action: "enter_long", riskApproved: false, rejectionReasons: ["最大回撤边界已触发"] },
    orderIntent: null, events, traceId: "trace-pin", startedAt: now,
    nextCycleAt: new Date(now.getTime() + 15_000), positionSizePct: 5,
  });

  const pinned = await pool.query(`
    SELECT prompt_configuration_version_id, prompt_payload_sha256, prompt_sha256
      FROM strategy_runtime_explanation_jobs
     WHERE cycle_id = 'cycle-pin' AND explanation_role = 'risk_explanation'
  `);
  assert.equal(pinned.rows[0].prompt_configuration_version_id, first.id);
  assert.equal(pinned.rows[0].prompt_payload_sha256, first.sha);
  // 任务快照里的 prompt_sha256 覆盖最终 system 全文，因此它证明的是「用了配置那一版」，
  // 而不只是「记了个版本号」。
  assert.equal(pinned.rows[0].prompt_sha256, expectedPrompt.hash);

  // 现在激活第二版。已入队的任务不受影响——PS-05 的全部内容。
  const second = await version("pin-version-2", "第二版：换成一段完全不同的职责说明文本。", 2);
  const secondPrompt = await resolveRuntimeExplanationPrompt("risk_explanation", second.instruction);
  assert.notEqual(secondPrompt.hash, expectedPrompt.hash, "两版必须产出不同的 Prompt，否则本用例恒真");

  const job = await leaseNextRuntimeExplanationJob(pool, {
    workerId: "pin-explanation-worker", now: new Date(now.getTime() + 1_000), leaseSeconds: 30,
  });
  assert.equal(job.explanationRole, "risk_explanation");
  assert.equal(job.promptConfigurationVersionId, first.id, "执行时读到的仍是入队时固定的那一版");
  assert.equal(job.promptHash, expectedPrompt.hash);
  assert.notEqual(job.promptHash, secondPrompt.hash);
});
