import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyWorkerHeartbeat,
  createWorkerHeartbeatReporter,
  deriveWorkerHealthState,
  normalizeWorkerErrorCode,
} from "../lib/worker-observability.ts";

test("classifies missing, alive and stale worker heartbeats", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  assert.equal(classifyWorkerHeartbeat(now, null), "missing");
  assert.equal(classifyWorkerHeartbeat(now, new Date("2026-08-20T11:59:01.000Z")), "alive");
  assert.equal(classifyWorkerHeartbeat(now, new Date("2026-08-20T11:59:00.000Z")), "stale");
});

test("normalizes worker failures without retaining secrets or prose", () => {
  assert.equal(normalizeWorkerErrorCode("provider timeout: key=secret"), "PROVIDER_TIMEOUT_KEY_SECRET");
  assert.equal(normalizeWorkerErrorCode(""), "UNKNOWN");
  assert.equal(normalizeWorkerErrorCode("x".repeat(200)).length, 80);
});

test("derives worker configuration, liveness and health without conflating them", () => {
  assert.equal(deriveWorkerHealthState({ configured: false, enabled: false, liveness: "missing", runtimeStatus: null }), "disabled");
  assert.equal(deriveWorkerHealthState({ configured: false, enabled: true, liveness: "missing", runtimeStatus: null }), "unconfigured");
  assert.equal(deriveWorkerHealthState({ configured: true, enabled: true, liveness: "missing", runtimeStatus: null }), "missing");
  assert.equal(deriveWorkerHealthState({ configured: true, enabled: true, liveness: "stale", runtimeStatus: "running" }), "stale");
  assert.equal(deriveWorkerHealthState({ configured: true, enabled: true, liveness: "alive", runtimeStatus: "error" }), "degraded");
  assert.equal(deriveWorkerHealthState({ configured: true, enabled: true, liveness: "alive", runtimeStatus: "running" }), "healthy");
});

test("worker reporter records an explicit lifecycle without logging an error body", async () => {
  const writes = [];
  const database = {
    async query(_text, values) {
      writes.push(values);
      return { rows: [] };
    },
  };
  const reporter = createWorkerHeartbeatReporter(database, {
    workerType: "notification",
    instanceId: "test-worker",
  });
  await reporter.start();
  reporter.setCurrentJob("delivery-1");
  await reporter.markFailure(new Error("provider secret body"), new Date("2026-08-20T12:00:00.000Z"));
  await reporter.stop();

  assert.deepEqual(writes.map((values) => values[3]), ["starting", "error", "stopped"]);
  assert.equal(writes[1][7], "ERROR");
  assert.equal(writes[2][8], null);
});

test("worker observability migration stores heartbeat and bounded diagnostics", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0025_worker_observability.sql", import.meta.url), "utf8");
  for (const field of ["worker_type", "instance_id", "commit_sha", "heartbeat_at", "last_success_at", "last_failure_at", "last_error_code", "current_job_id"]) {
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.match(migration, /PRIMARY KEY \("worker_type", "instance_id"\)/);
});

test("public health is coarse while maintenance diagnostics remain permission protected", async () => {
  const publicHealth = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publicHealth, /runtimeSetting|getPostgresPool|encryptionKey|researchQueue|emergencyStop/);
  assert.match(publicHealth, /shadow-paper-only/);

  const liveHealth = await readFile(new URL("../app/api/health/live/route.ts", import.meta.url), "utf8");
  assert.match(liveHealth, /status:\s*"alive"/);

  const readyHealth = await readFile(new URL("../app/api/health/ready/route.ts", import.meta.url), "utf8");
  assert.match(readyHealth, /SELECT 1/);
  assert.match(readyHealth, /status:\s*503/);

  const internalHealth = await readFile(new URL("../app/api/maintenance/payment-workers/health/route.ts", import.meta.url), "utf8");
  assert.match(internalHealth, /requireAccessPermission\(request, "maint\.system_health\.view"\)/);
  assert.match(internalHealth, /loadWorkerDiagnostics/);
  assert.match(internalHealth, /configured/);
  assert.match(internalHealth, /enabled/);
  assert.match(internalHealth, /health/);
});
