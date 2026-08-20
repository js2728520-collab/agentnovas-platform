import os from "node:os";

import pg from "pg";

import {
  claimNextEmailDelivery,
  loadResendProviderConfig,
  notificationSendEnvironmentReady,
  processClaimedEmail,
  providerConfigAllowsSend,
} from "../lib/notification-email-worker.ts";
import { businessDatabaseUrl } from "../lib/postgres.ts";

const connectionString = businessDatabaseUrl();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!notificationSendEnvironmentReady(process.env)) {
  throw new Error("Notification email sending is disabled or incompletely configured");
}

const poolSize = Number(process.env.NOTIFICATION_WORKER_POOL_SIZE || 4);
const pool = new pg.Pool({
  connectionString,
  max: Number.isInteger(poolSize) && poolSize > 0 && poolSize <= 20 ? poolSize : 4,
  application_name: "riverton-notification-worker",
});

const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const apiKey = process.env.RESEND_API_KEY.trim();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  process.stdout.write(`Notification Worker started (${workerId}).\n`);
  while (!stopping) {
    const config = await loadResendProviderConfig(pool);
    if (!config || !providerConfigAllowsSend(config)) {
      await delay(5_000);
      continue;
    }
    const delivery = await claimNextEmailDelivery(pool, { workerId, now: new Date() });
    if (!delivery) {
      await delay(1_000);
      continue;
    }
    try {
      const result = await processClaimedEmail(pool, delivery, { workerId, apiKey });
      process.stdout.write(`Notification ${delivery.id} ${result.status}.\n`);
    } catch (error) {
      console.error("Notification processing failed", {
        deliveryId: delivery.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }
} finally {
  await pool.end();
}
