import os from "node:os";

import pg from "pg";

import { researchDatabaseUrl } from "../lib/postgres.ts";
import {
  processNextRuntimeExplanation,
  processNextStrategyRuntimeDeployment,
} from "../lib/strategy-runtime-worker.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";

const connectionString = researchDatabaseUrl();
if (!connectionString) throw new Error("RESEARCH_DATABASE_URL or DATABASE_URL is required");
if (process.env.STRATEGY_RUNTIME_ENABLED !== "true") throw new Error("STRATEGY_RUNTIME_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.STRATEGY_RUNTIME_WORKER_POOL_SIZE || 6),
  application_name: "agentnovas-runtime-worker",
});
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const heartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "runtime",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  onError: (error) => console.error("Runtime Worker heartbeat failed", {
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

try {
  await heartbeat.start();
  while (!stopping) {
    try {
      const result = await processNextStrategyRuntimeDeployment(pool, { workerId });
      const explanation = await processNextRuntimeExplanation(pool, { workerId: `${workerId}-explanation` });
      if (!result && !explanation) await delay(1_000);
      else if (result?.status === "waiting_for_candle" && !explanation) await delay(250);
      else {
        heartbeat.setCurrentJob(result?.cycleId || explanation?.jobId || null);
        if (result?.status === "completed") console.info("Runtime cycle completed", {
          cycleId: result.cycleId,
          sequence: result.sequence,
          duplicate: result.duplicate,
        });
        if (explanation) console.info("Runtime explanation processed", {
          jobId: explanation.jobId,
          cycleId: explanation.cycleId,
          status: explanation.status,
        });
        await heartbeat.markSuccess();
      }
    } catch (error) {
      await heartbeat.markFailure(error);
      console.error("Runtime cycle failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
      await delay(1_000);
    }
  }
} finally {
  await heartbeat.stop();
  await pool.end();
}
