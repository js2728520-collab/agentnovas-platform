import os from "node:os";

import pg from "pg";

import { leaseNextResearchRun } from "../lib/postgres-research-queue.ts";
import { processResearchStage } from "../lib/strategy-research-orchestrator.ts";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.STRATEGY_RESEARCH_ENABLED !== "true") throw new Error("STRATEGY_RESEARCH_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.STRATEGY_RESEARCH_WORKER_POOL_SIZE || 6),
  application_name: "agentnovas-research-worker",
});
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
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
    try {
      await processResearchStage(pool, run, workerId);
    } catch (error) {
      console.error("Research stage failed", {
        runId: run.id,
        stage: run.stage,
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
    }
  }
} finally {
  await pool.end();
}
