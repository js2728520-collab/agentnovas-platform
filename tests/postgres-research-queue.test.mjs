import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  advanceResearchRun,
  appendResearchEvent,
  createResearchRun,
  listResearchCandidates,
  listOwnedResearchRuns,
  leaseNextResearchRun,
  pauseResearchRunForMissingRoles,
  pauseResearchRunForUserInput,
  requeueResearchRunsPausedForRoles,
  requestResearchRunCancellation,
  resumeResearchRunWithAnswers,
} from "../lib/postgres-research-queue.ts";
import {
  getOwnedCandidateForSave,
  getOwnedStrategyDraftById,
  getSavedStrategyDraftForCandidate,
  loadInternalCandidates,
  markCandidateSaved,
  reserveResearchModelCalls,
  upsertResearchCandidate,
  withResearchCandidateSaveLock,
} from "../lib/research-repository.ts";
import { runCheckpointedResearchStep } from "../lib/research-steps.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `strategy_research_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({
  connectionString: databaseUrl,
  max: 6,
  options: `-c search_path=${schema}`,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migration = await readFile(
    new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  const conversationDecouplingMigration = await readFile(
    new URL("../postgres/migrations/0014_research_conversation_decoupling.sql", import.meta.url),
    "utf8",
  );
  await pool.query(conversationDecouplingMigration);
  // 0080 给研发运行加了 Prompt 配置固定列（PS-05）。整份 0080 还会改运行时解释任务表并
  // 引用 configuration_versions，两者都不在本套件的表子集里，因此只取这一条 ALTER。
  // 与 0080 里的定义保持一致。
  await pool.query(`
    ALTER TABLE strategy_research_runs
      ADD COLUMN IF NOT EXISTS prompt_configuration_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
  await pool.query(`
    CREATE TABLE community_strategies (
      id text PRIMARY KEY,
      author_user_id text NOT NULL,
      specification_json text NOT NULL,
      validation_label text NOT NULL
    );
    CREATE TABLE strategy_versions (
      id text PRIMARY KEY,
      strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE CASCADE,
      version integer NOT NULL,
      specification_json text NOT NULL
    );
  `);
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE strategy_research_runs, community_strategies CASCADE");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

function runInput(overrides = {}) {
  return {
    ownerUserId: "user-a",
    conversationId: "conversation-a",
    exchangeAccountId: "exchange-a",
    mode: "standard",
    brief: { symbol: "BTCUSDT", timeframe: "1h", maxDrawdownPct: 12 },
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

async function establishLegacyLeaseForStateTransitionTest(runId, workerId, now, leaseSeconds = 30) {
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
  const result = await pool.query(`
    UPDATE strategy_research_runs
    SET status='running', lease_owner=$2, lease_expires_at=$3,
        attempts=attempts+1, started_at=COALESCE(started_at,$4), updated_at=$4
    WHERE id=$1
    RETURNING *
  `, [runId, workerId, leaseExpiresAt, now]);
  return result.rows[0];
}

test("creates research runs idempotently per tenant", async () => {
  const idempotencyKey = crypto.randomUUID();
  const first = await createResearchRun(pool, runInput({ idempotencyKey }));
  const repeated = await createResearchRun(pool, runInput({ idempotencyKey }));
  const otherTenant = await createResearchRun(pool, runInput({ ownerUserId: "user-b", idempotencyKey }));

  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, otherTenant.id);
  assert.equal(first.status, "queued");
  assert.equal(first.mode, "standard");
});

test("lists only the owner's latest runs and supports conversation-free research tasks", async () => {
  const older = await createResearchRun(pool, runInput({
    conversationId: null,
    idempotencyKey: "owner-a-older",
  }));
  await pool.query("UPDATE strategy_research_runs SET created_at = $2 WHERE id = $1", [
    older.id,
    new Date("2026-08-18T00:00:00.000Z"),
  ]);
  const latest = await createResearchRun(pool, runInput({
    conversationId: null,
    idempotencyKey: "owner-a-latest",
  }));
  await createResearchRun(pool, runInput({
    ownerUserId: "user-b",
    conversationId: null,
    idempotencyKey: "owner-b-latest",
  }));

  const runs = await listOwnedResearchRuns(pool, {
    ownerUserId: "user-a",
    limit: 1,
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, latest.id);
  assert.equal(runs[0].conversationId, null);
});

test("reuses a completed step checkpoint without calling the model twice", async () => {
  const run = await createResearchRun(pool, runInput({
    agentRoleSnapshot: {
      requirements: { profileId: "profile-a", revisionId: "revision-a", revisionNumber: 1, modelName: "model-a" },
    },
  }));
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return { modelName: "model-a", promptVersion: "2.0.0", promptHash: "a".repeat(64), output: { conclusion: "done" } };
  };
  const options = {
    runId: run.id,
    stage: "requirements",
    stepKey: "requirements:agent",
    input: { brief: run.brief },
    modelProfileId: "profile-a",
    modelRevisionId: "revision-a",
    execute,
  };

  const first = await runCheckpointedResearchStep(pool, options);
  const recovered = await runCheckpointedResearchStep(pool, options);
  const row = (await pool.query("SELECT * FROM strategy_research_steps WHERE run_id = $1", [run.id])).rows[0];

  assert.equal(calls, 1);
  assert.deepEqual(recovered, first);
  assert.equal(row.status, "completed");
  assert.equal(row.attempt_count, 1);
  assert.equal(row.model_revision_id, "revision-a");
  assert.equal(row.prompt_sha256, "a".repeat(64));
});

test("commercial Beta does not lease queued or expired legacy research runs", async () => {
  const first = await createResearchRun(pool, runInput());
  const second = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T10:00:00.000Z");

  const [leaseA, leaseB] = await Promise.all([
    leaseNextResearchRun(pool, { workerId: "worker-a", now, leaseSeconds: 30 }),
    leaseNextResearchRun(pool, { workerId: "worker-b", now, leaseSeconds: 30 }),
  ]);

  assert.equal(leaseA, null);
  assert.equal(leaseB, null);
  await pool.query(`
    UPDATE strategy_research_runs
    SET status='running', lease_owner='stale-worker', lease_expires_at=$2
    WHERE id=$1
  `, [first.id, new Date("2026-08-18T10:00:30.000Z")]);
  const recovered = await leaseNextResearchRun(pool, {
    workerId: "worker-c",
    now: new Date("2026-08-18T10:00:31.000Z"),
    leaseSeconds: 30,
  });
  assert.equal(recovered, null);
  const rows = await pool.query(`SELECT id,status,lease_owner FROM strategy_research_runs ORDER BY id`);
  assert.deepEqual(new Set(rows.rows.map((row) => row.id)), new Set([first.id, second.id]));
  assert.equal(rows.rows.find((row) => row.id === first.id).lease_owner, "stale-worker");
});

test("records cancellation without allowing another worker to reclaim the run", async () => {
  const run = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T11:00:00.000Z");
  const leased = await establishLegacyLeaseForStateTransitionTest(run.id, "worker-cancel", now);
  assert.equal(leased.id, run.id);

  const cancelled = await requestResearchRunCancellation(pool, {
    runId: run.id,
    ownerUserId: "user-a",
    now: new Date("2026-08-18T11:00:01.000Z"),
  });
  assert.equal(cancelled.cancelRequestedAt.toISOString(), "2026-08-18T11:00:01.000Z");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.leaseOwner, null);
  assert.equal(cancelled.completedAt.toISOString(), "2026-08-18T11:00:01.000Z");

  const reclaimed = await leaseNextResearchRun(pool, {
    workerId: "worker-after-cancel",
    now: new Date("2026-08-18T11:01:00.000Z"),
    leaseSeconds: 30,
  });
  assert.equal(reclaimed, null);
});

test("requeues every non-cancelled run paused for missing roles", async () => {
  const resumable = await createResearchRun(pool, runInput());
  const cancelled = await createResearchRun(pool, runInput());
  await pauseResearchRunForMissingRoles(pool, { runId: resumable.id, missingRoles: ["report"] });
  await pauseResearchRunForMissingRoles(pool, { runId: cancelled.id, missingRoles: ["report"] });
  await requestResearchRunCancellation(pool, {
    runId: cancelled.id,
    ownerUserId: "user-a",
    now: new Date("2026-08-18T11:10:00.000Z"),
  });

  const resumed = await requeueResearchRunsPausedForRoles(pool);

  assert.deepEqual(resumed.map((run) => run.id), [resumable.id]);
  assert.equal(resumed[0].status, "queued");
  assert.equal(resumed[0].lastErrorCode, null);
  const events = await pool.query("SELECT event_type FROM strategy_agent_events WHERE run_id = $1 ORDER BY sequence", [resumable.id]);
  assert.deepEqual(events.rows.map(row => row.event_type), ["paused", "resumed"]);
});

test("does not let a stale worker pause a run owned by another lease", async () => {
  const run = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T11:20:00.000Z");
  await establishLegacyLeaseForStateTransitionTest(run.id, "worker-current", now);

  await assert.rejects(
    pauseResearchRunForMissingRoles(pool, {
      runId: run.id,
      missingRoles: ["report"],
      workerId: "worker-stale",
    }),
    /租约已失效/,
  );
});

test("pauses for bounded customer input and resumes only for the owning tenant", async () => {
  const run = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T11:30:00.000Z");
  await establishLegacyLeaseForStateTransitionTest(run.id, "worker-input", now);
  const missingFields = [{ key: "maxDrawdownPct", question: "最大回撤限制？", options: [8, 12], defaultValue: 12 }];
  const paused = await pauseResearchRunForUserInput(pool, {
    runId: run.id,
    workerId: "worker-input",
    requirements: { conclusion: "需要风险边界", brief: {}, missingFields },
    missingFields,
    modelName: "requirements-model",
  });
  assert.equal(paused.status, "awaiting_user_input");
  assert.equal(paused.leaseOwner, null);

  await assert.rejects(
    resumeResearchRunWithAnswers(pool, {
      runId: run.id,
      ownerUserId: "other-user",
      answers: { maxDrawdownPct: 8 },
    }),
    /不存在|无需补充/,
  );
  const resumed = await resumeResearchRunWithAnswers(pool, {
    runId: run.id,
    ownerUserId: "user-a",
    answers: { maxDrawdownPct: 8 },
  });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.brief.maxDrawdownPct, 8);
  const events = await pool.query("SELECT event_type FROM strategy_agent_events WHERE run_id = $1 ORDER BY sequence", [run.id]);
  assert.deepEqual(events.rows.map(row => row.event_type), ["input_required", "input_received"]);
});

test("appends public events with a transactionally increasing sequence", async () => {
  const run = await createResearchRun(pool, runInput());
  const first = await appendResearchEvent(pool, {
    runId: run.id,
    role: "requirements",
    type: "conclusion",
    title: "需求已结构化",
    content: { symbol: "BTCUSDT" },
  });
  const second = await appendResearchEvent(pool, {
    runId: run.id,
    role: "market_regime",
    type: "evidence",
    title: "市场状态分段完成",
    content: { regimes: 3 },
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
});

test("advances one fixed stage only for the active lease owner", async () => {
  const run = await createResearchRun(pool, runInput());
  assert.equal(run.stage, "requirements");
  const now = new Date("2026-08-18T12:00:00.000Z");
  await establishLegacyLeaseForStateTransitionTest(run.id, "worker-stage", now);

  await assert.rejects(
    advanceResearchRun(pool, {
      runId: run.id,
      workerId: "stale-worker",
      completedStage: "requirements",
      now,
      event: {
        role: "requirements",
        type: "conclusion",
        title: "不应写入",
        content: {},
      },
    }),
    /租约/,
  );

  const advanced = await advanceResearchRun(pool, {
    runId: run.id,
    workerId: "worker-stage",
    completedStage: "requirements",
    now,
    event: {
      role: "requirements",
      type: "conclusion",
      title: "需求已结构化",
      content: { missingFields: [] },
    },
  });

  assert.equal(advanced.run.stage, "data_loading");
  assert.equal(advanced.run.status, "queued");
  assert.equal(advanced.run.attempts, 0);
  assert.equal(advanced.run.progress, 15);
  assert.equal(advanced.event.sequence, 1);
});

test("reserves model calls atomically and rejects calls beyond the run budget", async () => {
  const run = await createResearchRun(pool, runInput({ mode: "quick" }));
  assert.equal(run.modelCallBudget, 14);
  const now = new Date("2026-08-18T12:30:00.000Z");
  await establishLegacyLeaseForStateTransitionTest(run.id, "worker-budget", now);

  const reserved = await reserveResearchModelCalls(pool, {
    runId: run.id,
    workerId: "worker-budget",
    count: 10,
  });
  assert.equal(reserved.model_calls_used, 10);
  const fullyReserved = await reserveResearchModelCalls(pool, {
    runId: run.id,
    workerId: "worker-budget",
    count: run.modelCallBudget - 10,
  });
  assert.equal(fullyReserved.model_calls_used, run.modelCallBudget);
  await assert.rejects(
    reserveResearchModelCalls(pool, { runId: run.id, workerId: "worker-budget" }),
    /预算已耗尽/,
  );
});

test("stores candidates idempotently and enforces tenant ownership when saving", async () => {
  const run = await createResearchRun(pool, runInput());
  const dsl = {
    schemaVersion: 2,
    name: "候选",
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long_only",
    legs: { long: { entry: { all: [{ type: "ema_cross", fastPeriod: 10, slowPeriod: 30, direction: "bullish" }] }, exit: { any: [] }, stopLossPct: 2, takeProfitPct: 4 } },
    risk: { positionSizePct: 10, maxDrawdownPct: 12, maxDailyLossPct: 5, maxConsecutiveLosses: 4 },
  };
  const firstId = await upsertResearchCandidate(pool, { runId: run.id, key: "proposal-a-1", strategyFamily: "趋势", sourceRole: "proposal_a", dsl });
  const repeatedId = await upsertResearchCandidate(pool, { runId: run.id, key: "proposal-a-1", strategyFamily: "趋势修订", sourceRole: "proposal_a", dsl: { ...dsl, name: "候选修订" } });
  const candidates = await loadInternalCandidates(pool, run.id);

  assert.equal(firstId, repeatedId);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].dsl.name, "候选修订");
  assert.equal(await getOwnedCandidateForSave(pool, { runId: run.id, candidateId: firstId, ownerUserId: "other-user" }), null);
  const owned = await getOwnedCandidateForSave(pool, { runId: run.id, candidateId: firstId, ownerUserId: "user-a" });
  assert.equal(owned.id, firstId);
  await pool.query("UPDATE strategy_candidates SET validation_label='STANDARD_VERIFIED' WHERE id=$1", [firstId]);
  assert.equal(await getSavedStrategyDraftForCandidate(pool, { candidateId: firstId }), null);
  const savedDsl = { ...dsl, name: "用户编辑后的候选", risk: { ...dsl.risk, positionSizePct: 4 } };
  await pool.query(
    "INSERT INTO community_strategies(id,author_user_id,specification_json,validation_label) VALUES($1,$2,$3,$4)",
    ["strategy-a", "user-a", JSON.stringify(savedDsl), "UNVERIFIED"],
  );
  await pool.query(
    "INSERT INTO strategy_versions(id,strategy_id,version,specification_json) VALUES($1,$2,$3,$4)",
    ["version-a", "strategy-a", 1, JSON.stringify(savedDsl)],
  );
  assert.equal(await getOwnedStrategyDraftById(pool, { strategyId: "strategy-a", ownerUserId: "other-user" }), null);
  assert.deepEqual(await getOwnedStrategyDraftById(pool, { strategyId: "strategy-a", ownerUserId: "user-a" }), {
    strategyId: "strategy-a",
    strategyVersionId: "version-a",
    version: 1,
    specification: savedDsl,
    validationLabel: "UNVERIFIED",
  });
  assert.equal(await markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-a", strategyVersionId: "version-a" }), "strategy-a");
  assert.equal(await markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-a", strategyVersionId: "version-a" }), "strategy-a");
  const publicCandidates = await listResearchCandidates(pool, { runId: run.id, ownerUserId: "user-a" });
  assert.equal(publicCandidates[0].dsl.name, "用户编辑后的候选");
  assert.equal(publicCandidates[0].dsl.risk.positionSizePct, 4);
  assert.equal(publicCandidates[0].validationLabel, "UNVERIFIED");
  assert.equal(publicCandidates[0].edited, true);
  assert.deepEqual(await getSavedStrategyDraftForCandidate(pool, { candidateId: firstId }), {
    strategyId: "strategy-a",
    strategyVersionId: "version-a",
    version: 1,
    specification: savedDsl,
    validationLabel: "UNVERIFIED",
  });
  await assert.rejects(markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-b", strategyVersionId: "version-b" }), /其他策略/);
});

test("serializes concurrent saves for the same candidate", async () => {
  let active = 0;
  let maximumActive = 0;
  const order = [];

  await Promise.all(["first", "second"].map(label => withResearchCandidateSaveLock(
    pool,
    "candidate-lock-fixture",
    async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${label}:start`);
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push(`${label}:finish`);
      active -= 1;
    },
  )));

  assert.equal(maximumActive, 1);
  assert.match(order.join(","), /^(first:start,first:finish,second:start,second:finish|second:start,second:finish,first:start,first:finish)$/);
});
