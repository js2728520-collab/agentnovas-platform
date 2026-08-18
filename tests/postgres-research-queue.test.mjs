import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  advanceResearchRun,
  appendResearchEvent,
  createResearchRun,
  leaseNextResearchRun,
  requestResearchRunCancellation,
} from "../lib/postgres-research-queue.ts";

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

  const reclaimed = await leaseNextResearchRun(pool, {
    workerId: "worker-after-cancel",
    now: new Date("2026-08-18T11:01:00.000Z"),
    leaseSeconds: 30,
  });
  assert.equal(reclaimed, null);
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
  assert.equal(advanced.run.progress, 15);
  assert.equal(advanced.event.sequence, 1);
});
