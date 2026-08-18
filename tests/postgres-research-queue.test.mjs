import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  advanceResearchRun,
  appendResearchEvent,
  createResearchRun,
  leaseNextResearchRun,
  pauseResearchRunForMissingRoles,
  pauseResearchRunForUserInput,
  requeueResearchRunsPausedForRoles,
  requestResearchRunCancellation,
  resumeResearchRunWithAnswers,
} from "../lib/postgres-research-queue.ts";
import {
  getOwnedCandidateForSave,
  loadInternalCandidates,
  markCandidateSaved,
  reserveResearchModelCalls,
  upsertResearchCandidate,
} from "../lib/research-repository.ts";

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
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE strategy_research_runs CASCADE");
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

test("leases distinct runs concurrently and recovers an expired worker lease", async () => {
  const first = await createResearchRun(pool, runInput());
  const second = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T10:00:00.000Z");

  const [leaseA, leaseB] = await Promise.all([
    leaseNextResearchRun(pool, { workerId: "worker-a", now, leaseSeconds: 30 }),
    leaseNextResearchRun(pool, { workerId: "worker-b", now, leaseSeconds: 30 }),
  ]);

  assert.ok(leaseA);
  assert.ok(leaseB);
  assert.notEqual(leaseA.id, leaseB.id);
  assert.deepEqual(new Set([leaseA.id, leaseB.id]), new Set([first.id, second.id]));

  const unavailable = await leaseNextResearchRun(pool, {
    workerId: "worker-c",
    now: new Date("2026-08-18T10:00:10.000Z"),
    leaseSeconds: 30,
  });
  assert.equal(unavailable, null);

  const recovered = await leaseNextResearchRun(pool, {
    workerId: "worker-c",
    now: new Date("2026-08-18T10:00:31.000Z"),
    leaseSeconds: 30,
  });
  assert.ok(recovered);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.leaseOwner, "worker-c");
});

test("records cancellation without allowing another worker to reclaim the run", async () => {
  const run = await createResearchRun(pool, runInput());
  const now = new Date("2026-08-18T11:00:00.000Z");
  const leased = await leaseNextResearchRun(pool, { workerId: "worker-cancel", now, leaseSeconds: 30 });
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
  await leaseNextResearchRun(pool, { workerId: "worker-current", now, leaseSeconds: 30 });

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
  await leaseNextResearchRun(pool, { workerId: "worker-input", now, leaseSeconds: 30 });
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
  await leaseNextResearchRun(pool, { workerId: "worker-stage", now, leaseSeconds: 30 });

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
  await leaseNextResearchRun(pool, { workerId: "worker-budget", now, leaseSeconds: 30 });

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
  assert.equal(await markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-a" }), "strategy-a");
  assert.equal(await markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-a" }), "strategy-a");
  await assert.rejects(markCandidateSaved(pool, { candidateId: firstId, strategyId: "strategy-b" }), /其他策略/);
});
