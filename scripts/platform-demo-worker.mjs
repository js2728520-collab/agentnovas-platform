import { getPostgresPool } from "../lib/postgres.ts";
import { processNextPlatformDemoExecution } from "../lib/platform-demo-execution.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";
import { demoExecutionWorkerConfig } from "../lib/demo-worker-config.ts";
import { runDemoWorkerIteration } from "../lib/demo-worker-loop.ts";

const workerConfig = demoExecutionWorkerConfig();
if (!workerConfig.processEnabled) {
  throw new Error("DEMO_EXECUTION_WORKER_ENABLED is not true; Demo execution worker remains disabled");
}

const workerId = process.env.PLATFORM_DEMO_WORKER_ID?.trim() || `platform-demo-${process.pid}`;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

const pool = await getPostgresPool();
const heartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "demo_execution",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  onError: (error) => process.stderr.write(`${JSON.stringify({
    event: "platform_demo_worker_heartbeat_error",
    workerId,
    errorName: error instanceof Error ? error.name : "Error",
  })}\n`),
});

try {
  await heartbeat.start();
  process.stdout.write(`${JSON.stringify({
    event: "platform_demo_worker_started",
    workerId,
    externalWritesEnabled: workerConfig.externalWritesEnabled,
  })}\n`);
  while (!stopping) {
    try {
      const result = await runDemoWorkerIteration({
        processNext: () => processNextPlatformDemoExecution(pool, { workerId, leaseSeconds: 60 }),
        markSuccess: () => heartbeat.markSuccess(),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      });
      if (result && result.status !== "disabled") {
        process.stdout.write(`${JSON.stringify({ event: "platform_demo_execution_result", workerId, ...result })}\n`);
      }
    } catch (error) {
      await heartbeat.markFailure(error);
      process.stderr.write(`${JSON.stringify({
        event: "platform_demo_worker_error",
        workerId,
        errorName: error instanceof Error ? error.name : "Error",
      })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
} finally {
  await heartbeat.stop();
  await pool.end();
}
process.stdout.write(`${JSON.stringify({ event: "platform_demo_worker_stopped", workerId })}\n`);
