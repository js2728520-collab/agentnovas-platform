import os from "node:os";

import pg from "pg";

import { researchDatabaseUrl } from "../lib/postgres.ts";

const connectionString = researchDatabaseUrl();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.NOTIFICATION_WORKER_ENABLED !== "true") throw new Error("NOTIFICATION_WORKER_ENABLED must be true");

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.NOTIFICATION_WORKER_POOL_SIZE || 4),
  application_name: "riverton-notification-worker",
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
  process.stdout.write(`Notification Worker started (${workerId}). Channels send only after provider configs are active.\n`);
  while (!stopping) {
    await pool.query("SELECT 1");
    await delay(5_000);
  }
} finally {
  await pool.end();
}

