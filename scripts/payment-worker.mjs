import os from "node:os";

import pg from "pg";

import { researchDatabaseUrl } from "../lib/postgres.ts";

const connectionString = researchDatabaseUrl();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.PAYMENT_WORKER_ENABLED !== "true") throw new Error("PAYMENT_WORKER_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PAYMENT_WORKER_POOL_SIZE || 4),
  application_name: "riverton-payment-worker",
});

const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  process.stdout.write(`Payment Worker started (${workerId}). Real providers remain disabled until configured.\n`);
  while (!stopping) {
    await pool.query("SELECT 1");
    await delay(5_000);
  }
} finally {
  await pool.end();
}

