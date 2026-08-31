import os from "node:os";
import { readFile } from "node:fs/promises";

import pg from "pg";

import { applyPaymentSecretConfigurationToDirectory, decryptPaymentSecretEnvelope } from "../lib/payment-secret-broker.ts";
import {
  claimPaymentSecretRequest, completePaymentSecretRequest, failPaymentSecretRequest,
  recordPaymentSecretBrokerHeartbeat,
} from "../lib/payment-secret-management.ts";
import { businessDatabaseUrl } from "../lib/postgres.ts";
import { normalizeWorkerErrorCode } from "../lib/worker-observability.ts";

const connectionString = businessDatabaseUrl();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.PAYMENT_SECRET_BROKER_ENABLED !== "true") throw new Error("PAYMENT_SECRET_BROKER_DISABLED");
const keyId = process.env.PAYMENT_SECRET_BROKER_KEY_ID?.trim() ?? "";
const privateKeyPath = process.env.PAYMENT_SECRET_BROKER_PRIVATE_KEY_PATH?.trim() ?? "";
const directory = process.env.PAYMENT_SECRET_DIRECTORY?.trim() ?? "";
const allowedCallbackHosts = (process.env.PAYMENT_ALLOWED_CALLBACK_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (!/^[A-Za-z0-9._:-]{8,80}$/.test(keyId) || !privateKeyPath || !directory || !allowedCallbackHosts.length) {
  throw new Error("PAYMENT_SECRET_BROKER_CONFIGURATION_INVALID");
}
const privateKeyPem = await readFile(privateKeyPath, "utf8");
if (privateKeyPem.length < 1_000 || privateKeyPem.length > 16_384) throw new Error("PAYMENT_SECRET_PRIVATE_KEY_INVALID");

const pool = new pg.Pool({ connectionString, max: 2, application_name: "riverton-payment-secret-broker" });
const workerId = `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`;
let currentRequestId = null;
let heartbeatStatus = "starting";
const heartbeat = (overrides = {}) => recordPaymentSecretBrokerHeartbeat(pool, {
  instanceId: workerId, status: heartbeatStatus, commitSha: process.env.GIT_COMMIT_SHA,
  currentRequestId, ...overrides,
}).catch(error => console.error("Payment Secret Broker heartbeat failed", {
  code: normalizeWorkerErrorCode(error instanceof Error ? error.message : error),
}));
const heartbeatTimer = setInterval(() => { void heartbeat(); }, 15_000);
heartbeatTimer.unref?.();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

try {
  process.stdout.write(`Payment Secret Broker started (${workerId}).\n`);
  await heartbeat();
  heartbeatStatus = "running";
  while (!stopping) {
    const request = await claimPaymentSecretRequest(pool, { workerId, now: new Date() });
    if (!request) { await delay(1_000); continue; }
    currentRequestId = request.id;
    await heartbeat();
    try {
      const configuration = await decryptPaymentSecretEnvelope(request.envelope, { keyId, privateKeyPem, allowedCallbackHosts });
      const applied = await applyPaymentSecretConfigurationToDirectory({
        directory, requestId: request.id, configuration, now: new Date(),
      });
      if (!await completePaymentSecretRequest(pool, {
        requestId: request.id, workerId, version: applied.version,
        fingerprint: applied.fingerprint, now: new Date(),
      })) throw new Error("PAYMENT_SECRET_BROKER_FENCED");
      currentRequestId = null;
      await heartbeat({ lastSuccessAt: new Date() });
      process.stdout.write(`${JSON.stringify({ event: "payment_secret_configuration_applied", requestId: request.id, version: applied.version })}\n`);
    } catch (error) {
      const errorCode = normalizeWorkerErrorCode(error instanceof Error ? error.message : error);
      await failPaymentSecretRequest(pool, { requestId: request.id, workerId, errorCode, now: new Date() }).catch(() => false);
      currentRequestId = null;
      heartbeatStatus = "error";
      await heartbeat({ lastFailureAt: new Date(), lastErrorCode: errorCode });
      heartbeatStatus = "running";
      console.error("Payment Secret Broker request failed", { requestId: request.id, code: errorCode });
    }
  }
} finally {
  clearInterval(heartbeatTimer);
  heartbeatStatus = "stopped";
  currentRequestId = null;
  await heartbeat();
  await pool.end();
}
