import os from "node:os";

import pg from "pg";

import { researchDatabaseUrl } from "../lib/postgres.ts";
import { leaseNextResearchRun, renewResearchRunLease } from "../lib/postgres-research-queue.ts";
import { processResearchStage } from "../lib/strategy-research-orchestrator.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";

const connectionString = researchDatabaseUrl();
if (!connectionString) throw new Error("RESEARCH_DATABASE_URL or DATABASE_URL is required");
if (process.env.STRATEGY_RESEARCH_ENABLED !== "true") throw new Error("STRATEGY_RESEARCH_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.STRATEGY_RESEARCH_WORKER_POOL_SIZE || 6),
  application_name: "agentnovas-research-worker",
});
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const workerHeartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "research",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  onError: (error) => console.error("Research Worker heartbeat failed", {
    code: error instanceof Error ? error.name : "UNKNOWN",
  }),
});
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function leaseHeartbeat(runId) {
  let timer;
  let stopped = false;
  let failure = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await renewResearchRunLease(pool, { runId, workerId, now: new Date(), leaseSeconds: 300 });
    } catch (error) {
      failure = error;
    }
    if (!stopped) timer = setTimeout(tick, 60_000);
  };
  timer = setTimeout(tick, 60_000);
  return {
    stop() { stopped = true; clearTimeout(timer); },
    failure() { return failure; },
  };
}

try {
  await workerHeartbeat.start();
  while (!stopping) {
    const run = await leaseNextResearchRun(pool, {
      workerId,
      now: new Date(),
      leaseSeconds: 300,
    });
    if (!run) {
      await delay(1_000);
      continue;
    }
    workerHeartbeat.setCurrentJob(run.id);
    const heartbeat = leaseHeartbeat(run.id);
    try {
      await processResearchStage(pool, run, workerId);
      if (heartbeat.failure()) throw heartbeat.failure();
      await workerHeartbeat.markSuccess();
    } catch (error) {
      await workerHeartbeat.markFailure(error);
      console.error("Research stage failed", {
        runId: run.id,
        stage: run.stage,
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
    } finally {
      heartbeat.stop();
    }
  }
} finally {
  await workerHeartbeat.stop();
  await pool.end();
}
