import { hostname } from "node:os";

import { processNextSecretCommand } from "../lib/ai-secret-broker-worker.ts";
import { getAiSecretBrokerPostgresPool } from "../lib/postgres.ts";

if (process.env.AI_SECRET_BROKER_ENABLED !== "true") {
  process.stdout.write("AI Secret Broker is disabled.\n");
  process.exit(0);
}

const brokerPrivateKeyPath = process.env.AI_SECRET_BROKER_PRIVATE_KEY_FILE?.trim() ?? "";
const brokerPrivateKeyDirectory = process.env.AI_SECRET_BROKER_PRIVATE_KEY_DIRECTORY?.trim() ?? "";
const managedDirectory = process.env.AI_MANAGED_SECRET_DIRECTORY?.trim() ?? "";
const brokerInstanceId = `ai-secret-broker:${hostname()}:${process.pid}`;
const pool = await getAiSecretBrokerPostgresPool();

async function runOnce() {
  const result = await processNextSecretCommand(pool,{
    brokerInstanceId,
    brokerPrivateKeyPath,
    brokerPrivateKeyDirectory,
    managedDirectory,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv.includes("--once")) {
  await runOnce();
  await pool.end();
} else {
  let stopping = false;
  process.on("SIGTERM",() => { stopping = true; });
  process.on("SIGINT",() => { stopping = true; });
  while (!stopping) {
    const result = await runOnce();
    if (!result.processed) await new Promise(resolveDelay => setTimeout(resolveDelay,1_000));
  }
  await pool.end();
}
