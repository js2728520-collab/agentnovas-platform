import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maintenanceQueueDisplayStatus,
  maintenanceResourceDisplayStatus,
  maintenanceResourcePhase,
} from "../packages/contracts/src/riverton-ui.ts";

test("maintenance resource phases fail closed across loading, errors, missing data and ready data", () => {
  assert.equal(maintenanceResourcePhase({ data: null, loading: true, error: "" }), "loading");
  assert.equal(maintenanceResourcePhase({ data: null, loading: false, error: "worker endpoint failed" }), "error");
  assert.equal(maintenanceResourcePhase({ data: null, loading: false, error: "" }), "unknown");
  assert.equal(maintenanceResourcePhase({ data: { status: "ready" }, loading: false, error: "" }), "ready");
  assert.equal(maintenanceResourcePhase({ data: { status: "old" }, loading: false, error: "refresh failed" }), "error");

  assert.equal(maintenanceResourceDisplayStatus("loading"), "loading");
  assert.equal(maintenanceResourceDisplayStatus("error"), "unavailable");
  assert.equal(maintenanceResourceDisplayStatus("unknown"), "unknown");
  assert.equal(maintenanceResourceDisplayStatus("ready"), "ready");
});

test("queue health never defaults to healthy when worker diagnostics are missing, failed or incomplete", () => {
  assert.equal(maintenanceQueueDisplayStatus("loading", null), "loading");
  assert.equal(maintenanceQueueDisplayStatus("error", null), "unavailable");
  assert.equal(maintenanceQueueDisplayStatus("unknown", null), "unknown");
  assert.equal(maintenanceQueueDisplayStatus("ready", []), "unknown");
  assert.equal(maintenanceQueueDisplayStatus("ready", [{ status: "unexpected" }]), "unknown");
  assert.equal(maintenanceQueueDisplayStatus("ready", [{ status: "healthy" }]), "healthy");
  assert.equal(maintenanceQueueDisplayStatus("ready", [{ status: "warning" }]), "warning");
  assert.equal(maintenanceQueueDisplayStatus("ready", [{ status: "critical" }, { status: "healthy" }]), "critical");
});

test("Maintenance health UI gates every summary on its own resource and preserves per-resource retry", async () => {
  const source = await readFile(new URL("../apps/maintenance/ui/system-health-workspace.tsx", import.meta.url), "utf8");
  for (const name of ["healthPhase", "workersPhase", "emailPhase", "paymentsPhase"]) {
    assert.match(source, new RegExp(`const ${name} = maintenanceResourcePhase`));
  }
  assert.match(source, /maintenanceQueueDisplayStatus\(workersPhase/);
  assert.match(source, /ResourceAvailability/);
  assert.match(source, /retry=\{workers\.refresh\}/);
  assert.match(source, /retry=\{email\.refresh\}/);
  assert.match(source, /retry=\{payments\.refresh\}/);
  assert.doesNotMatch(source, /workers\.data\?\.paymentWorker\.enabled\s*\?[^:]+:\s*"进程开关为 disabled"/s);
  assert.doesNotMatch(source, /email\.data\?\.configured\s*\?\s*"configured"\s*:\s*"unconfigured"/);
  assert.doesNotMatch(source, /queues\.some[\s\S]+:\s*"healthy"/);
});
