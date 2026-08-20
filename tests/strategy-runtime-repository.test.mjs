import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  applyPaperFundingRates,
  completeRuntimeExplanationJob,
  completeStrategyRuntimeCycle,
  createStrategyDeployment,
  endConflictingOfficialStrategyDeployments,
  leaseNextRuntimeExplanationJob,
  leaseNextStrategyDeployment,
  OfficialStrategyModeSwitchOpenPositionError,
  renewStrategyRuntimeLease,
} from "../lib/strategy-runtime-repository.ts";
import {
  processLeasedStrategyRuntimeDeployment,
  processNextRuntimeExplanation,
} from "../lib/strategy-runtime-worker.ts";
import {
  ensureOfficialPaperPortfolios,
  resolveOfficialThreeCardPortfolioScope,
  settlePendingOfficialPaperOrder,
} from "../lib/official-paper-repository.ts";
import { evaluatePlatformStrategy, PLATFORM_AI_STRATEGIES } from "../lib/platform-ai-strategies.ts";
import { platformStrategyDslV3 } from "../lib/platform-strategy-v3.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_runtime_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });

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

function candleRows(count = 30) {
  const rows = Array.from({ length: count }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  rows[29] = { ...rows[29], open: 100, high: 112, low: 99, close: 111 };
  return rows;
}

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
    if (evaluatePlatformStrategy(PLATFORM_AI_STRATEGIES.ai_conservative, "BTCUSDT", rows, false).action === "enter") return rows;
  }
  throw new Error("official entry fixture not found");
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

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE strategy_versions (id text PRIMARY KEY, specification_json text NOT NULL);
    CREATE TABLE exchange_accounts (id text PRIMARY KEY, exchange text NOT NULL);
    CREATE TABLE memberships (id text PRIMARY KEY, customer_id text NOT NULL, status text NOT NULL, expires_at text, grace_ends_at text);
    CREATE TABLE strategy_subscriptions (id text PRIMARY KEY);
    CREATE TABLE platform_decisions (id text PRIMARY KEY);
    CREATE TABLE trades (id text PRIMARY KEY);
  `);
  for (const filename of [
    "0001_strategy_research.sql",
    "0004_market_data_snapshots.sql",
    "0007_strategy_runtime.sql",
    "0013_runtime_explanations.sql",
    "0020_runtime_final_decision.sql",
    "0024_platform_demo_execution.sql",
  ]) {
    const migration = await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8");
    await pool.query(migration);
  }
  await pool.query(`INSERT INTO strategy_versions (id, specification_json) VALUES ('version-a', $1)`, [JSON.stringify(dsl)]);
  await pool.query(`INSERT INTO strategy_versions (id, specification_json) VALUES ('version-official', $1)`, [JSON.stringify(platformStrategyDslV3("ai_conservative", "BTCUSDT"))]);
  await pool.query(`INSERT INTO exchange_accounts (id, exchange) VALUES ('account-a', 'binance')`);
  await pool.query(`INSERT INTO memberships (id, customer_id, status, expires_at, grace_ends_at) VALUES ('membership-official', 'owner-official', 'active', NULL, NULL)`);
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE strategy_deployments, official_paper_portfolios, runtime_explanation_bindings, llm_profiles CASCADE");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("leases with fencing tokens and recovers an expired runtime worker", async () => {
  const deployment = await seedDeployment("shadow");
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
  const deployment = await seedDeployment("shadow");
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
  const deployment = await seedDeployment("shadow");
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

test("paper runtime fills a prior signal only at the next complete candle open", async () => {
  const deployment = await seedDeployment("paper");
  let rows = candleRows();
  const adapter = {
    exchange: "binance",
    async getInstrument() {
      return { exchange: "binance", symbol: "BTCUSDT", exchangeSymbol: "BTCUSDT", status: "live", quoteAsset: "USDT", tickSize: 0.1, lotSize: 0.001, fundingIntervalHours: 8 };
    },
    async getCandles() {
      return { items: rows, duplicateCount: 0, incompleteCount: 0, invalidCount: 0, reversedInput: false };
    },
    async getFundingRates() {
      return { items: [{ time: rows.at(-1).openTime, rate: 0.0001 }], duplicateCount: 0, incompleteCount: 0, invalidCount: 0, reversedInput: false };
    },
    async getFeeSchedule() {
      return { makerRate: 0.0005, takerRate: 0.0007, estimated: true, source: "test" };
    },
  };
  const dependencies = {
    createAdapter: () => adapter,
    saveSnapshot: async (_database, input) => ({ id: input.sourceId, candleSha256: "a", fundingSha256: "b", datasetSha256: "c" }),
  };
  const firstNow = new Date(Date.now() + 60_000);
  const firstLease = await leaseNextStrategyDeployment(pool, { workerId: "runtime-a", now: firstNow, leaseSeconds: 30 });
  const first = await processLeasedStrategyRuntimeDeployment(pool, firstLease, "runtime-a", { ...dependencies, now: () => firstNow });
  assert.equal(first.decision.action, "enter_long");
  assert.equal((await pool.query("SELECT status FROM strategy_paper_order_intents")).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_paper_positions")).rows[0].count, 0);

  rows = [...rows, {
    openTime: 30 * 3_600_000, closeTime: 31 * 3_600_000 - 1,
    open: 113, high: 114, low: 112, close: 113, volume: 100,
  }];
  const secondNow = new Date(firstNow.getTime() + 16_000);
  const secondLease = await leaseNextStrategyDeployment(pool, { workerId: "runtime-b", now: secondNow, leaseSeconds: 30 });
  await processLeasedStrategyRuntimeDeployment(pool, secondLease, "runtime-b", { ...dependencies, now: () => secondNow });
  const position = (await pool.query("SELECT entry_price, status FROM strategy_paper_positions")).rows[0];
  assert.equal(Number(position.entry_price), 113);
  assert.equal(position.status, "open");
  assert.equal((await pool.query("SELECT status FROM strategy_paper_order_intents ORDER BY created_at LIMIT 1")).rows[0].status, "filled");
  const repeatedFunding = await applyPaperFundingRates(pool, {
    deploymentId: deployment.id,
    rates: [{ time: rows.at(-1).openTime, rate: 0.0001 }],
  });
  assert.equal(repeatedFunding.applied, 0);
  assert.ok(Number((await pool.query("SELECT funding_usdt FROM strategy_paper_positions WHERE status = 'open'")).rows[0].funding_usdt) > 0);
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
  const spotAdapter = {
    async getCandles() { return { items: rows, provider: "fixture" }; },
    async getFeeSchedule() { return { makerRate: 0.001, takerRate: 0.001, source: "fixture" }; },
  };
  const dependencies = {
    createSpotAdapter: () => spotAdapter,
    saveSnapshot: async (_database, input) => ({ id: input.sourceId, candleSha256: "a", fundingSha256: "b", datasetSha256: "c" }),
  };
  const firstNow = new Date(Date.now() + 60_000);
  const firstLease = await leaseNextStrategyDeployment(pool, { workerId: "official-runtime-a", now: firstNow, leaseSeconds: 30 });
  assert.equal(firstLease.id, deployment.id);
  assert.equal(firstLease.exchangeAccountId, null);
  assert.equal(firstLease.executionProduct, "spot_usdt");
  const first = await processLeasedStrategyRuntimeDeployment(pool, firstLease, "official-runtime-a", { ...dependencies, now: () => firstNow });
  assert.equal(first.decision.action, "enter_long");
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
  const secondNow = new Date(firstNow.getTime() + 16_000);
  const secondLease = await leaseNextStrategyDeployment(pool, { workerId: "official-runtime-b", now: secondNow, leaseSeconds: 30 });
  await processLeasedStrategyRuntimeDeployment(pool, secondLease, "official-runtime-b", { ...dependencies, now: () => secondNow });
  const storedPortfolio = (await pool.query(`
    SELECT principal_usdt, cash_usdt FROM official_paper_portfolios WHERE id = $1
  `, [portfolio.id])).rows[0];
  assert.equal(Number(storedPortfolio.principal_usdt), 10_000);
  assert.ok(Number(storedPortfolio.cash_usdt) < 10_000);
  assert.equal((await pool.query("SELECT side FROM official_paper_positions WHERE portfolio_id = $1 AND status = 'open'", [portfolio.id])).rows[0].side, "long");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM strategy_paper_funding_accruals WHERE deployment_id = $1", [deployment.id])).rows[0].count, 0);
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
  const insertPending = async (sequence, action) => {
    const cycleId = `settlement-access-cycle-${sequence}`;
    await pool.query(`
      INSERT INTO strategy_runtime_cycles (
        id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
        status, decision_json, trace_id, started_at
      ) VALUES ($1, $2, $3, 1, $4, $4, 'completed', '{}'::jsonb, $5, $4)
    `, [cycleId, deployment.id, sequence, new Date(`2026-08-2${sequence}T00:00:00.000Z`), `trace-${sequence}`]);
    await pool.query(`
      INSERT INTO official_paper_order_intents (
        id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
        symbol, action, execution_timing, requested_price, status, payload_json
      ) VALUES ($1, $2, $3, $4, $5, 'BTCUSDT', $6, 'next_candle_open', 50000, 'pending', $7::jsonb)
    `, [crypto.randomUUID(), portfolio.id, deployment.id, cycleId, `settlement-access-${sequence}`, action,
      JSON.stringify({ quoteAmountUsdt: 100, takerFeeRate: 0.001 })]);
  };

  await insertPending(1, "buy");
  assert.equal((await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date("2026-08-21T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-active-buy",
  }))?.status, "filled");
  await pool.query(`
    UPDATE memberships
    SET status = 'expired', expires_at = '2026-08-21T00:00:00.000Z', grace_ends_at = '2026-08-21T00:00:00.000Z'
    WHERE id = $1
  `, [membershipId]);
  await insertPending(2, "sell");
  assert.equal((await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 51_000,
    fillTime: new Date("2026-08-22T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-expired-sell",
  }))?.status, "filled");
  await insertPending(3, "buy");
  const expiredBuy = await settlePendingOfficialPaperOrder(pool, {
    deploymentId: deployment.id,
    fillPrice: 50_000,
    fillTime: new Date("2026-08-23T00:00:00.000Z"),
    timing: "next_candle_open",
    traceId: "settle-expired-buy",
  });
  assert.equal(expiredBuy?.status, "rejected");
  assert.match(expiredBuy?.reason || "", /只允许平仓|只读/);
  assert.equal((await pool.query("SELECT access_status FROM official_paper_portfolios WHERE id = $1", [portfolio.id])).rows[0].access_status, "read_only");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_paper_positions WHERE portfolio_id = $1 AND status = 'open'", [portfolio.id])).rows[0].count, 0);
});
