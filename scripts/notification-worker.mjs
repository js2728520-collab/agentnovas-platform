import os from "node:os";

import pg from "pg";

import {
  claimNextEmailDelivery,
  loadResendProviderConfig,
  notificationEmailAllowlist,
  notificationSendEnvironmentReady,
  processClaimedEmail,
  providerConfigAllowsSend,
  purgeExpiredNotificationSecrets,
} from "../lib/notification-email-worker.ts";
import { businessDatabaseUrl } from "../lib/postgres.ts";
import { createWorkerHeartbeatReporter } from "../lib/worker-observability.ts";
import { reconcileMembershipAccessTransitions } from "../lib/membership-lifecycle.ts";

const connectionString = businessDatabaseUrl();
if (!connectionString) throw new Error("DATABASE_URL is required");
const sendEnabled = notificationSendEnvironmentReady(process.env);

const poolSize = Number(process.env.NOTIFICATION_WORKER_POOL_SIZE || 4);
const pool = new pg.Pool({
  connectionString,
  max: Number.isInteger(poolSize) && poolSize > 0 && poolSize <= 20 ? poolSize : 4,
  application_name: "riverton-notification-worker",
});

const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
const heartbeat = createWorkerHeartbeatReporter(pool, {
  workerType: "notification",
  instanceId: workerId,
  commitSha: process.env.GIT_COMMIT_SHA,
  metadata: {
    processEnabled: process.env.NOTIFICATION_WORKER_ENABLED === "true",
    emailSendEnabled: process.env.NOTIFICATION_EMAIL_SEND_ENABLED === "true",
    apiKeyPresent: Boolean(process.env.RESEND_API_KEY?.trim()),
    allowlistConfigured: notificationEmailAllowlist(process.env).size > 0,
    tokenEncryptionKeyPresent: (process.env.NOTIFICATION_TOKEN_ENCRYPTION_KEY?.trim().length ?? 0) >= 32,
    emailEnvironmentReady: sendEnabled,
  },
  onError: (error) => console.error("Notification Worker heartbeat failed", {
    code: error instanceof Error ? error.name : "UNKNOWN",
  }),
});
const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
let stopping = false;
let nextSecretCleanupAt = 0;
let nextMembershipReconciliationAt = 0;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  process.stdout.write(`Notification Worker started (${workerId}).\n`);
  await heartbeat.start();
  while (!stopping) {
    const now = new Date();
    if (now.getTime() >= nextSecretCleanupAt) {
      try {
        await purgeExpiredNotificationSecrets(pool, now);
      } catch (error) {
        console.error("Notification secret cleanup failed", {
          code: error instanceof Error ? error.name : "UNKNOWN",
        });
      }
      nextSecretCleanupAt = now.getTime() + 5 * 60_000;
    }
    if (now.getTime() >= nextMembershipReconciliationAt) {
      try {
        const lifecycle = await reconcileMembershipAccessTransitions(pool, { now, limit: 100 });
        if (lifecycle.transitioned > 0) {
          await heartbeat.markSuccess(now);
          process.stdout.write(`${JSON.stringify({ event: "membership_lifecycle_reconciled", ...lifecycle })}\n`);
        }
      } catch (error) {
        await heartbeat.markFailure(error, now);
        console.error("Membership lifecycle reconciliation failed", {
          code: error instanceof Error ? error.name : "UNKNOWN",
        });
      }
      nextMembershipReconciliationAt = now.getTime() + 30_000;
    }
    if (!sendEnabled) {
      await delay(5_000);
      continue;
    }
    const config = await loadResendProviderConfig(pool);
    if (!config || !providerConfigAllowsSend(config)) {
      await delay(5_000);
      continue;
    }
    const delivery = await claimNextEmailDelivery(pool, { workerId, now });
    if (!delivery) {
      await delay(1_000);
      continue;
    }
    heartbeat.setCurrentJob(delivery.id);
    try {
      const result = await processClaimedEmail(pool, delivery, { workerId, apiKey });
      await heartbeat.markSuccess();
      process.stdout.write(`Notification ${delivery.id} ${result.status}.\n`);
    } catch (error) {
      await heartbeat.markFailure(error);
      console.error("Notification processing failed", {
        deliveryId: delivery.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }
} finally {
  await heartbeat.stop();
  await pool.end();
}
