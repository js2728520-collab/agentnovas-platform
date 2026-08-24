import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  evaluateAndRecordAdmission,
  loadActiveAdmissionThresholds,
  loadAdmissionEvaluation,
} from "../lib/strategy-admission-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_listing_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

async function seedStrategy(id, { status = "draft", riskLevel = "medium", version = 1 } = {}) {
  await pool.query(`
    INSERT INTO community_strategies(id,author_user_id,name,risk_level,status,version,validation_label)
    VALUES ($1,'listing-author',$2,$3,$4,$5,'STANDARD_VERIFIED')
  `, [id, `策略 ${id}`, riskLevel, status, version]);
}

async function seedBacktest(id, strategyId, overrides = {}) {
  const facts = {
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2025-12-31T00:00:00.000Z",
    sampleSize: 42,
    netReturnPct: 12.5,
    maxDrawdownPct: 9,
    ...overrides,
  };
  await pool.query(`
    INSERT INTO strategy_validations(
      id,strategy_id,kind,status,period_start,period_end,sample_size,
      net_return_pct,max_drawdown_pct,strategy_version,completed_at
    ) VALUES ($1,$2,'backtest','passed',$3,$4,$5,$6,$7,1,'2026-01-01T00:00:00.000Z')
  `, [id, strategyId, facts.periodStart, facts.periodEnd, facts.sampleSize, facts.netReturnPct, facts.maxDrawdownPct]);
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-listing-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "listing-review-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('listing-author','listing-author@quality.invalid','test-only-hash','customer','active'),
      ('listing-reviewer','listing-reviewer@quality.invalid','test-only-hash','hq_admin','active')
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("旧状态被迁移到新词表，且约束拒绝旧值", async () => {
  // published/paused 是 0081 之前的写法。paused 尤其是语义错误：它在订阅与部署上表示
  // 「可恢复的暂停」，而下架不可恢复。
  await assert.rejects(
    pool.query(`INSERT INTO community_strategies(id,author_user_id,name,status)
                VALUES ('legacy-published','listing-author','旧','published')`),
    (error) => /community_strategies_status_check/.test(error.message),
  );
  await assert.rejects(
    pool.query(`INSERT INTO community_strategies(id,author_user_id,name,status)
                VALUES ('legacy-paused','listing-author','旧','paused')`),
    (error) => /community_strategies_status_check/.test(error.message),
  );
});

test("没有已激活配置时门槛回落到已冻结的 P-05，而不是无门槛", async () => {
  const active = await loadActiveAdmissionThresholds(pool);
  assert.equal(active.configurationVersionId, null);
  assert.equal(active.thresholds.minimumBacktestDays, 180);
  assert.equal(active.thresholds.minimumTrades, 30);
  assert.equal(active.thresholds.requiresManualReview, true);
});

test("准入判定逐项落库，可事后复核", async () => {
  await seedStrategy("strategy-pass");
  await seedBacktest("backtest-pass", "strategy-pass");
  const evaluation = await evaluateAndRecordAdmission(pool, {
    strategyId: "strategy-pass", strategyVersion: 1, riskLevel: "medium",
    validationLabel: "STANDARD_VERIFIED",
  });
  assert.equal(evaluation.result.meetsThresholds, true);
  assert.equal(evaluation.validationId, "backtest-pass");

  const stored = await loadAdmissionEvaluation(pool, { strategyId: "strategy-pass", strategyVersion: 1 });
  // PRD 6.5：「不得用口头结论替代」——逐项结果与档位都要能事后复核。
  assert.equal(stored.meetsThresholds, true);
  assert.equal(stored.riskTier, "balanced");
  assert.ok(stored.checks.some((check) => check.id === "backtest_period" && check.required === 180));
});

test("未达门槛时记录的是哪几条不达标，而不是一个布尔", async () => {
  await seedStrategy("strategy-fail", { riskLevel: "low" });
  // 回撤 12% 对保守档（10%）超标，样本 12 笔不足 30 笔。
  await seedBacktest("backtest-fail", "strategy-fail", { maxDrawdownPct: 12, sampleSize: 12 });
  const evaluation = await evaluateAndRecordAdmission(pool, {
    strategyId: "strategy-fail", strategyVersion: 1, riskLevel: "low",
    validationLabel: "STANDARD_VERIFIED",
  });
  assert.equal(evaluation.result.meetsThresholds, false);
  assert.deepEqual(evaluation.result.failedCheckIds.sort(), ["max_drawdown", "trade_sample"]);

  const stored = await loadAdmissionEvaluation(pool, { strategyId: "strategy-fail", strategyVersion: 1 });
  assert.equal(stored.meetsThresholds, false);
  assert.equal(stored.riskTier, "conservative");
});

test("没有通过的回测时是「先去跑回测」，不是「你的策略不达标」", async () => {
  await seedStrategy("strategy-no-backtest");
  // 两者对作者是不同的指引，合并成「不达标」会让人去改策略而不是去跑回测。
  await assert.rejects(
    () => evaluateAndRecordAdmission(pool, {
      strategyId: "strategy-no-backtest", strategyVersion: 1, riskLevel: "medium",
      validationLabel: "STANDARD_VERIFIED",
    }),
    (error) => {
      assert.equal(error.code, "STRATEGY_BACKTEST_REQUIRED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("重新判定同一版本落在同一行上", async () => {
  await seedBacktest("backtest-pass-2", "strategy-pass", { sampleSize: 99 });
  await evaluateAndRecordAdmission(pool, {
    strategyId: "strategy-pass", strategyVersion: 1, riskLevel: "medium",
    validationLabel: "STANDARD_VERIFIED",
  });
  const rows = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_admission_evaluations WHERE strategy_id='strategy-pass'",
  );
  assert.equal(rows.rows[0].count, 1, "每个 (策略, 版本) 只应有一条判定");
});

test("上架审核权限与通用审批权限分开登记", async () => {
  // 能处理内部审批不等于能放行策略上架——后者决定哪些策略能被客户跟随并投入真实资金。
  const permissions = await pool.query(
    "SELECT key, sensitive FROM permission_definitions WHERE key LIKE 'ops.strategy_listing.%' ORDER BY key",
  );
  assert.deepEqual(permissions.rows.map((row) => row.key),
    ["ops.strategy_listing.review", "ops.strategy_listing.view"]);
  assert.equal(permissions.rows.find((row) => row.key === "ops.strategy_listing.review").sensitive, true);
});

test("审核路由已登记，且投稿不再是死胡同", async () => {
  const inventory = await readFile(new URL("../lib/api-route-inventory.ts", import.meta.url), "utf8");
  // 此前投稿会创建 strategy_listing 审批单，而唯一的审批端点明确拒绝该类型，
  // 于是没有任何路径能让策略走到已上架——整个策略广场从未跑通。
  assert.match(inventory, /"\/api\/operations\/strategy-listing-reviews\/:id\/decision"/);
  assert.match(inventory, /"ops\.strategy_listing\.review"/);
});
