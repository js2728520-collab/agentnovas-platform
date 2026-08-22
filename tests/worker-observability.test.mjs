import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyWorkerHeartbeat,
  createWorkerHeartbeatReporter,
  deriveWorkerHealthState,
  normalizeWorkerErrorCode,
} from "../lib/worker-observability.ts";
import { demoExecutionWorkerConfig } from "../lib/demo-worker-config.ts";
import { runDemoWorkerIteration } from "../lib/demo-worker-loop.ts";

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
  const statements = [];
  const database = {
    async query(text, values) {
      statements.push(text);
      writes.push(values);
      return { rows: [] };
    },
  };
  const reporter = createWorkerHeartbeatReporter(database, {
    workerType: "notification",
    instanceId: "test-worker",
    metadata: {
      apiKeyPresent: true,
      emailEnvironmentReady: false,
    },
  });
  await reporter.start();
  reporter.setCurrentJob("delivery-1");
  await reporter.markFailure(new Error("provider secret body"), new Date("2026-08-20T12:00:00.000Z"));
  await reporter.markSuccess(new Date("2026-08-20T12:01:00.000Z"));
  await reporter.stop();

  assert.deepEqual(writes.map((values) => values[3]), ["starting", "error", "running", "stopped"]);
  assert.equal(writes[1][7], "ERROR");
  assert.equal(writes[2][5], "2026-08-20T12:01:00.000Z");
  assert.equal(writes[3][8], null);
  assert.deepEqual(JSON.parse(writes[0][9]), {
    apiKeyPresent: true,
    emailEnvironmentReady: false,
  });
  assert.match(statements[0], /WHEN EXCLUDED\.last_success_at IS NOT NULL THEN NULL/);
});

test("worker metadata only retains bounded boolean readiness markers", async () => {
  const writes = [];
  await createWorkerHeartbeatReporter({
    async query(_text, values) {
      writes.push(values);
      return { rows: [] };
    },
  }, {
    workerType: "notification",
    instanceId: "metadata-worker",
    metadata: {
      apiKeyPresent: true,
      secretValue: "must-not-be-persisted",
      ["x".repeat(81)]: true,
    },
  }).start();
  assert.deepEqual(JSON.parse(writes[0][9]), { apiKeyPresent: true });
});

test("worker observability migration stores heartbeat and bounded diagnostics", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0025_worker_observability.sql", import.meta.url), "utf8");
  for (const field of ["worker_type", "instance_id", "commit_sha", "heartbeat_at", "last_success_at", "last_failure_at", "last_error_code", "current_job_id"]) {
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.match(migration, /PRIMARY KEY \("worker_type", "instance_id"\)/);
});

test("public health is coarse while maintenance diagnostics remain permission protected", async () => {
  const publicHealth = await readFile(new URL("../app/api/health/route.shared.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publicHealth, /runtimeSetting|getPostgresPool|encryptionKey|researchQueue|emergencyStop/);
  assert.match(publicHealth, /shadow-paper-only/);

  const liveHealth = await readFile(new URL("../app/api/health/live/route.shared.ts", import.meta.url), "utf8");
  assert.match(liveHealth, /status:\s*"alive"/);

  const readyHealth = await readFile(new URL("../app/api/health/ready/route.shared.ts", import.meta.url), "utf8");
  assert.match(readyHealth, /SELECT 1/);
  assert.match(readyHealth, /status:\s*503/);

  const internalHealth = await readFile(new URL("../app/api/maintenance/payment-workers/health/route.maintenance.ts", import.meta.url), "utf8");
  assert.match(internalHealth, /requireAccessPermission\(request, "maint\.system_health\.view"\)/);
  assert.match(internalHealth, /loadWorkerDiagnostics/);
  assert.match(internalHealth, /configured/);
  assert.match(internalHealth, /enabled/);
  assert.match(internalHealth, /health/);
});

test("platform Demo worker reports lifecycle health and stays explicitly gated", async () => {
  const worker = await readFile(new URL("../scripts/platform-demo-worker.mjs", import.meta.url), "utf8");
  const health = await readFile(new URL("../app/api/maintenance/payment-workers/health/route.maintenance.ts", import.meta.url), "utf8");
  const demoEnvironment = await readFile(new URL("../deploy/env/demo.env.example", import.meta.url), "utf8");
  const maintenanceEnvironment = await readFile(new URL("../deploy/env/maintenance.env.example", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(worker, /workerConfig\.processEnabled/);
  assert.match(worker, /getDemoExecutionPostgresPool/);
  assert.doesNotMatch(worker, /getPostgresPool/);
  assert.doesNotMatch(worker, /if\s*\([^)]*PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED/);
  assert.match(worker, /createWorkerHeartbeatReporter/);
  assert.match(worker, /workerType:\s*"demo_execution"/);
  assert.match(worker, /heartbeat\.start\(\)/);
  assert.match(worker, /heartbeat\.markSuccess\(\)/);
  assert.match(worker, /heartbeat\.markFailure\(error\)/);
  assert.match(worker, /heartbeat\.stop\(\)/);
  assert.match(health, /externalWritesEnabled/);
  assert.match(health, /executionEnabled/);
  assert.match(demoEnvironment, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(demoEnvironment, /^DATABASE_URL=postgresql:\/\/agentnovas_demo_execution_worker:/m);
  assert.match(demoEnvironment, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.match(maintenanceEnvironment, /^DEMO_EXECUTION_WORKER_ENABLED=false$/m);
  assert.match(maintenanceEnvironment, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
  assert.match(packageJson.scripts["worker:demo"], /scripts\/platform-demo-worker\.mjs/);
});

test("Demo process liveness and external-write authorization remain independent", () => {
  assert.deepEqual(demoExecutionWorkerConfig({
    DEMO_EXECUTION_WORKER_ENABLED: "true",
    PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "false",
  }), {
    processEnabled: true,
    externalWritesEnabled: false,
    executionEnabled: false,
  });
  assert.deepEqual(demoExecutionWorkerConfig({
    DEMO_EXECUTION_WORKER_ENABLED: "true",
    PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "true",
  }), {
    processEnabled: true,
    externalWritesEnabled: true,
    executionEnabled: true,
  });
});

test("Demo standby mode backs off without recording false execution success", async () => {
  const calls = [];
  const result = await runDemoWorkerIteration({
    processNext: async () => {
      calls.push("process");
      return { status: "disabled" };
    },
    markSuccess: async () => calls.push("success"),
    sleep: async (milliseconds) => calls.push(`sleep:${milliseconds}`),
    idleDelayMs: 5_000,
  });
  assert.deepEqual(result, { status: "disabled" });
  assert.deepEqual(calls, ["process", "sleep:5000"]);
});
