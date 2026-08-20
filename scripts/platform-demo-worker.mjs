import { getPostgresPool } from "../lib/postgres.ts";
import { processNextPlatformDemoExecution } from "../lib/platform-demo-execution.ts";

if (process.env.PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED !== "true") {
  throw new Error("PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED is not true; Demo execution worker remains disabled");
}

const workerId = process.env.PLATFORM_DEMO_WORKER_ID?.trim() || `platform-demo-${process.pid}`;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

const pool = await getPostgresPool();
process.stdout.write(`${JSON.stringify({ event: "platform_demo_worker_started", workerId })}\n`);
while (!stopping) {
  try {
    const result = await processNextPlatformDemoExecution(pool, { workerId, leaseSeconds: 60 });
    if (result && result.status !== "disabled") {
      process.stdout.write(`${JSON.stringify({ event: "platform_demo_execution_result", workerId, ...result })}\n`);
    }
    if (!result) await new Promise((resolve) => setTimeout(resolve, 5_000));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      event: "platform_demo_worker_error",
      workerId,
      errorName: error instanceof Error ? error.name : "Error",
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
process.stdout.write(`${JSON.stringify({ event: "platform_demo_worker_stopped", workerId })}\n`);
