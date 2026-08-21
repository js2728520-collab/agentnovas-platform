import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maintenanceIdempotencyKeyHash,
  maintenanceIdempotencyOperation,
} from "../lib/maintenance-idempotency.ts";

test("Maintenance idempotency accepts only the two enabled critical operations and never stores the raw key", () => {
  assert.equal(
    maintenanceIdempotencyOperation("maintenance.source_integration.test"),
    "maintenance.source_integration.test",
  );
  assert.equal(
    maintenanceIdempotencyOperation("maintenance.trading.emergency_stop"),
    "maintenance.trading.emergency_stop",
  );
  assert.throws(
    () => maintenanceIdempotencyOperation("maintenance.payment.enable"),
    /operation/i,
  );
  const hash = maintenanceIdempotencyKeyHash("maintenance-command-key-0001");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("maintenance-command-key-0001"), false);
});

test("source checks and emergency stop require the shared persistent idempotency command", async () => {
  const [sourceRoute, emergencyRoute, migration, grants] = await Promise.all([
    readFile(new URL("../app/api/maintenance/integrations/[id]/test/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/maintenance/trading/emergency-stop/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0039_maintenance_idempotency.sql", import.meta.url), "utf8"),
    readFile(new URL("../deploy/postgres/least-privilege-roles.sql", import.meta.url), "utf8"),
  ]);
  for (const source of [sourceRoute, emergencyRoute]) {
    assert.match(source, /idempotencyKey\(request\)/);
    assert.match(source, /runMaintenanceIdempotentCommand|runIdempotentMaintenanceSourceIntegrationCheck/);
  }
  assert.match(migration, /maintenance_idempotency_records/);
  assert.match(migration, /processing.*succeeded.*failed/s);
  assert.match(migration, /canonical_payload_sha256/);
  assert.match(migration, /expires_at/);
  assert.match(migration, /MAINTENANCE_RECONCILIATION_REQUIRED/);
  assert.match(migration, /terminal.*immutable|immutable.*terminal/i);
  assert.match(grants, /maintenance_idempotency_records[\s\S]+TO agentnovas_maint_web/i);
});
