import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maintenanceIdempotencyKeyHash,
  maintenanceIdempotencyOperation,
} from "../lib/maintenance-idempotency.ts";

test("Maintenance idempotency accepts only the enabled critical operations and never stores the raw key", () => {
  assert.equal(
    maintenanceIdempotencyOperation("maintenance.source_integration.test"),
    "maintenance.source_integration.test",
  );
  assert.equal(
    maintenanceIdempotencyOperation("maintenance.trading.emergency_stop"),
    "maintenance.trading.emergency_stop",
  );
  assert.equal(
    maintenanceIdempotencyOperation("maintenance.work_records.export"),
    "maintenance.work_records.export",
  );
  assert.throws(
    () => maintenanceIdempotencyOperation("maintenance.payment.enable"),
    /operation/i,
  );
  const hash = maintenanceIdempotencyKeyHash("maintenance-command-key-0001");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("maintenance-command-key-0001"), false);
});

test("source checks, emergency stop, and work-record export require the shared persistent idempotency command", async () => {
  const [sourceRoute, emergencyRoute, exportRoute, migration, exportMigration, grants] = await Promise.all([
    readFile(new URL("../app/api/maintenance/integrations/[id]/test/route.maintenance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/maintenance/trading/emergency-stop/route.maintenance.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/maintenance/work-records/export/route.maintenance.ts", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0039_maintenance_idempotency.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0076_maintenance_work_record_export.sql", import.meta.url), "utf8"),
    readFile(new URL("../deploy/postgres/least-privilege-roles.sql", import.meta.url), "utf8"),
  ]);
  for (const source of [sourceRoute, emergencyRoute, exportRoute]) {
    assert.match(source, /idempotencyKey\(request\)/);
    assert.match(source, /runMaintenanceIdempotentCommand|runIdempotentMaintenanceSourceIntegrationCheck|runMaintenanceWorkRecordExport/);
  }
  assert.match(migration, /maintenance_idempotency_records/);
  assert.match(migration, /processing.*succeeded.*failed/s);
  assert.match(migration, /canonical_payload_sha256/);
  assert.match(migration, /expires_at/);
  assert.match(migration, /MAINTENANCE_RECONCILIATION_REQUIRED/);
  assert.match(migration, /terminal.*immutable|immutable.*terminal/i);
  assert.match(exportMigration, /maintenance\.work_records\.export/);
  assert.match(grants, /maintenance_idempotency_records[\s\S]+TO agentnovas_maint_web/i);
});
