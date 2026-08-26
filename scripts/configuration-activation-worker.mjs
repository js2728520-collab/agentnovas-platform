import os from "node:os";

import pg from "pg";

import { runDueConfigurationActivations } from "../lib/configuration-activation-worker.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";

if (process.env.CONFIGURATION_ACTIVATION_WORKER_ENABLED !== "true") {
  throw new Error("CONFIGURATION_ACTIVATION_WORKER_ENABLED must be true");
}
const rawDatabaseUrl = process.env.CONFIGURATION_ACTIVATION_DATABASE_URL?.trim();
if (!rawDatabaseUrl) throw new Error("CONFIGURATION_ACTIVATION_DATABASE_URL is required");
const databaseUrl = new URL(rawDatabaseUrl);
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)
  || databaseUrl.username !== "agentnovas_configuration_activation_worker") {
  throw new Error("CONFIGURATION_ACTIVATION_DATABASE_URL must use the dedicated worker role");
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const intervalMs = boundedInteger(process.env.CONFIGURATION_ACTIVATION_WORKER_INTERVAL_MS, 5_000, 1_000, 30_000);
const batchSize = boundedInteger(process.env.CONFIGURATION_ACTIVATION_WORKER_BATCH_SIZE, 50, 1, 100);
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 1,
  application_name: "riverton-configuration-activation-worker",
});
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const heartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "configuration_activation",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  metadata: { processEnabled: true, dedicatedDatabaseRole: true },
  onError: (error) => console.error("Configuration activation heartbeat failed", {
    code: error instanceof Error ? error.name : "UNKNOWN",
  }),
});
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  process.stdout.write(`Configuration Activation Worker started (${workerId}).\n`);
  await heartbeat.start();
  while (!stopping) {
    try {
      const result = await runDueConfigurationActivations(pool, { batchSize });
      if (result.failed > 0) {
        const error = new Error("One or more due configuration activations failed");
        error.name = "CONFIGURATION_ACTIVATION_BATCH_PARTIAL_FAILURE";
        await heartbeat.markFailure(error);
      } else {
        await heartbeat.markSuccess();
      }
      if (result.activated > 0 || result.failed > 0) {
        process.stdout.write(`${JSON.stringify({
          event: "configuration_activation_batch",
          leaseAcquired: result.leaseAcquired,
          scanned: result.scanned,
          activated: result.activated,
          skipped: result.skipped,
          failed: result.failed,
        })}\n`);
      }
    } catch (error) {
      await heartbeat.markFailure(error);
      console.error("Configuration activation iteration failed", {
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
    if (!stopping) await delay(intervalMs);
  }
} finally {
  await heartbeat.stop();
  await pool.end();
}
