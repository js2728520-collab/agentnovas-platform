import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMaintenanceQueue,
  loadMaintenanceHealthMetrics,
} from "../lib/maintenance-health-metrics.ts";

test("maintenance queue SLO evaluator has stable warning and critical boundaries", () => {
  assert.equal(evaluateMaintenanceQueue({ queue: "notification_email", depth: 0, oldestAgeSeconds: null }).status, "healthy");
  assert.equal(evaluateMaintenanceQueue({ queue: "notification_email", depth: 1, oldestAgeSeconds: 119 }).status, "healthy");
  assert.equal(evaluateMaintenanceQueue({ queue: "notification_email", depth: 1, oldestAgeSeconds: 120 }).status, "warning");
  assert.equal(evaluateMaintenanceQueue({ queue: "notification_email", depth: 1, oldestAgeSeconds: 300 }).status, "critical");
});

test("maintenance queue metrics expose only bounded aggregate labels and ages", async () => {
  const calls = [];
  const pool = { async query(sql, parameters) {
    calls.push({ sql, parameters });
    return { rows: [
      { queue: "notification_email", depth: "2", oldest_age_seconds: "130.4" },
      { queue: "demo_execution", depth: "0", oldest_age_seconds: null },
    ] };
  } };
  const metrics = await loadMaintenanceHealthMetrics(pool, new Date("2026-08-21T10:00:00.000Z"));
  assert.deepEqual(metrics.map((metric) => ({ queue: metric.queue, depth: metric.depth, status: metric.status })), [
    { queue: "notification_email", depth: 2, status: "warning" },
    { queue: "demo_execution", depth: 0, status: "healthy" },
  ]);
  assert.doesNotMatch(JSON.stringify(metrics), /userId|secret|payload|providerOrderId/i);
  assert.match(calls[0].sql, /count\(\*\)/);
  assert.doesNotMatch(calls[0].sql, /SELECT \*/i);
});
