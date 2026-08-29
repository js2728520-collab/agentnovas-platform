import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.equal(evaluateMaintenanceQueue({ queue: "configuration_activation", depth: 1, oldestAgeSeconds: 59 }).status, "healthy");
  assert.equal(evaluateMaintenanceQueue({ queue: "configuration_activation", depth: 1, oldestAgeSeconds: 60 }).status, "warning");
  assert.equal(evaluateMaintenanceQueue({ queue: "configuration_activation", depth: 1, oldestAgeSeconds: 300 }).status, "critical");
});

test("maintenance queue metrics expose only bounded aggregate labels and ages", async () => {
  const calls = [];
  const pool = { async query(sql, parameters) {
    calls.push({ sql, parameters });
    return { rows: [
      { queue: "notification_email", depth: "2", oldest_age_seconds: "130.4" },
      { queue: "demo_execution", depth: "0", oldest_age_seconds: null },
      { queue: "configuration_activation", depth: "1", oldest_age_seconds: "61" },
    ] };
  } };
  const metrics = await loadMaintenanceHealthMetrics(pool, new Date("2026-08-21T10:00:00.000Z"));
  assert.deepEqual(metrics.map((metric) => ({ queue: metric.queue, depth: metric.depth, status: metric.status })), [
    { queue: "notification_email", depth: 2, status: "warning" },
    { queue: "demo_execution", depth: 0, status: "healthy" },
    { queue: "configuration_activation", depth: 1, status: "warning" },
  ]);
  assert.doesNotMatch(JSON.stringify(metrics), /userId|secret|payload|providerOrderId/i);
  assert.match(calls[0].sql, /count\(\*\)/);
  assert.match(calls[0].sql, /configuration_schedules/);
  assert.doesNotMatch(calls[0].sql, /SELECT \*/i);
});

test("Maintenance health queries receive only their aggregate source columns", async () => {
  const roles = await readFile(new URL("../deploy/postgres/least-privilege-roles.sql", import.meta.url), "utf8");
  const expected = new Map([
    ["_agentnovas_migrations", ["name", "checksum", "commit_sha"]],
    ["strategy_research_runs", ["status", "next_attempt_at", "created_at"]],
    ["commercial_membership_orders", ["status", "created_at"]],
    ["performance_fee_statements", ["status", "created_at"]],
    ["commercial_plan_versions", ["status", "price_currency"]],
  ]);
  for (const [table, columns] of expected) {
    const grant = roles.match(new RegExp(`GRANT SELECT \\(([^)]+)\\)\\s+ON ${table} TO agentnovas_maint_web;`, "s"));
    assert.ok(grant, `${table} health grant is missing`);
    for (const column of columns) assert.match(grant[1], new RegExp(`\\b${column}\\b`));
    assert.doesNotMatch(grant[1], /customer_id|owner_user_id|amount|payload|credential|secret/i);
  }
});
