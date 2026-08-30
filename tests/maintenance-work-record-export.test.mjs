import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildMaintenanceWorkRecordExport,
  maintenanceWorkRecordExportSafeText,
  parseMaintenanceWorkRecordExportInput,
} from "../lib/maintenance-work-record-export.ts";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("Maintenance work-record export accepts only a bounded UTC range", () => {
  assert.deepEqual(parseMaintenanceWorkRecordExportInput({
    from: "2026-08-01",
    to: "2026-08-31",
  }), {
    from: "2026-08-01",
    to: "2026-08-31",
  });

  for (const body of [
    { from: "2026-07-31", to: "2026-08-31" },
    { from: "2026-08-02", to: "2026-08-01" },
    { from: "2026-02-29", to: "2026-03-01" },
    { from: "2026-08-01", to: "2026-08-02", reason: "旧客户端人工原因会被拒绝" },
    { from: "2026-08-01", to: "2026-08-02", extra: true },
  ]) {
    assert.throws(
      () => parseMaintenanceWorkRecordExportInput(body),
      (error) => error?.code === "VALIDATION_ERROR" && error?.status === 422,
      JSON.stringify(body),
    );
  }
});

test("Maintenance JSON export neutralizes spreadsheet formula prefixes and truncates honestly at 1000 rows", async () => {
  for (const value of ["=cmd", "+SUM(A1)", "-1+2", "@payload"]) {
    assert.equal(maintenanceWorkRecordExportSafeText(value), `'${value}`);
  }
  assert.equal(maintenanceWorkRecordExportSafeText("BTCUSDT"), "BTCUSDT");

  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: Array.from({ length: 1_001 }, (_, index) => ({
          workRecordRef: `WRK-${index}`,
          userRef: `USR-${index}`,
          strategyCode: index === 0 ? "=unsafe" : "ai_conservative",
          strategyVersion: "version-1",
          symbol: "BTCUSDT",
          timeframe: "1h",
          decisionStatus: "hold",
          completeness: "complete",
          executionMode: "paper",
          admissionStatus: "not_required",
          orderIntentCount: 0,
          fillReceiptCount: 0,
          occurredAt: new Date("2026-08-24T12:00:00.000Z"),
          isSharedDecision: true,
          realOrderRoutingEnabled: false,
        })),
      };
    },
  };

  const result = await buildMaintenanceWorkRecordExport(database, {
    from: "2026-08-01",
    to: "2026-08-31",
  }, new Date("2026-08-31T12:00:00.000Z"));

  assert.equal(result.data.length, 1_000);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 1_000);
  assert.equal(result.data[0].strategyCode, "'=unsafe");
  assert.equal(result.generatedAt, "2026-08-31T12:00:00.000Z");
  assert.deepEqual(result.period, { from: "2026-08-01", to: "2026-08-31", timezone: "UTC" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["2026-08-01", "2026-08-31", 1_001]);
  assert.match(calls[0].sql, /maintenance_strategy_work_records_safe/);
  assert.match(calls[0].sql, /occurred_at >= \(\$1::date::timestamp AT TIME ZONE 'UTC'\)/);
  assert.match(calls[0].sql, /occurred_at < \(\(\$2::date \+ 1\)::timestamp AT TIME ZONE 'UTC'\)/);
  assert.doesNotMatch(calls[0].sql, /strategy_subscription_periods|strategy_decision_rounds|users|SELECT\s+\*/i);
});

test("Maintenance work-record export is isolated behind one sensitive permission, safe view, and inline UI", async () => {
  const [migration, grants, route, service, ui, app, nav, routeContract, rbac, idempotency, rolePolicy] = await Promise.all([
    source("../postgres/migrations/0076_maintenance_work_record_export.sql"),
    source("../deploy/postgres/least-privilege-roles.sql"),
    source("../app/api/maintenance/work-records/export/route.maintenance.ts"),
    source("../lib/maintenance-work-record-export.ts"),
    source("../apps/maintenance/ui/work-record-export-workspace.tsx"),
    source("../apps/maintenance/ui/maintenance-app.tsx"),
    source("../apps/maintenance/ui/maintenance-information-architecture.ts"),
    source("../app/riverton-route-contract.ts"),
    source("../lib/rbac.ts"),
    source("../lib/maintenance-idempotency.ts"),
    source("../scripts/release/postgres-role-policy.mjs"),
  ]);

  assert.match(migration, /maint\.work_records\.export/);
  assert.match(migration, /VIEW maintenance_strategy_work_records_safe\s+WITH \(security_barrier = true\)/i);
  const safeView = migration.match(/CREATE OR REPLACE VIEW maintenance_strategy_work_records_safe[\s\S]*?;\n/i)?.[0] ?? "";
  assert.match(safeView, /USR-/);
  assert.doesNotMatch(safeView, /email|phone|encrypted|provider|error_message|evidence_json|explanation_json/i);
  assert.match(grants, /GRANT SELECT ON maintenance_strategy_work_records_safe TO agentnovas_maint_web/i);
  const maintenanceGrants = grants.slice(grants.indexOf("-- Maintenance receives"), grants.indexOf("-- Execution service"));
  assert.doesNotMatch(maintenanceGrants, /GRANT SELECT ON[^;]*(strategy_subscription_periods|strategy_decision_rounds|strategy_runtime_events|strategy_runtime_cycles)[^;]*agentnovas_maint_web/i);

  assert.match(route, /requireAccessPermission\(request,\s*PERMISSION\)/);
  assert.match(route, /readResearchJson\(request,\s*8_192\)/);
  assert.match(route, /idempotencyKey\(request\)/);
  assert.match(service, /runMaintenanceIdempotentCommand/);
  assert.match(service, /maintenance\.work_records\.export_generated/);
  assert.match(route, /content-disposition/);
  assert.match(route, /"x-export-retention": "idempotency-record-only"/);
  assert.match(route, /private, no-store, max-age=0/);
  assert.doesNotMatch(route, /writeFile|createWriteStream|fs\//);
  assert.match(service, /MAX_EXPORT_ROWS = 1_000/);
  assert.match(service, /maintenance_strategy_work_records_safe/);
  assert.doesNotMatch(service, /SELECT\s+\*/i);
  assert.match(idempotency, /maintenance\.work_records\.export/);
  assert.match(rolePolicy, /MAINTENANCE_WORK_RECORD_RAW_GRANT/);

  assert.match(ui, /工作记录脱敏导出/);
  assert.doesNotMatch(ui, /导出原因|auditReason|InlineAuditReasonField/);
  assert.match(ui, /服务端自动留痕/);
  assert.match(ui, /Idempotency-Key/);
  assert.match(ui, /不可变幂等终态记录/);
  assert.doesNotMatch(ui, /confirm\s*\(|window\.confirm|alert\s*\(/);
  assert.match(app, /WorkRecordExportWorkspace/);
  assert.match(nav, /\/\?tab=records/);
  assert.match(routeContract, /"work-records"/);
  assert.match(rbac, /maint\.work_records\.export/);

  const { API_ROUTE_INVENTORY } = await import("../lib/api-route-inventory.ts");
  const policy = API_ROUTE_INVENTORY.find((entry) => entry.method === "POST" && entry.route === "/api/maintenance/work-records/export");
  assert.deepEqual(policy?.audiences, ["maintenance"]);
  assert.deepEqual(policy?.permissionKeys, ["maint.work_records.export"]);
  assert.equal(policy?.mfa, "recent");
  assert.equal(policy?.pii, "masked");
  assert.equal(policy?.sensitivity, "sensitive");
  assert.equal(policy?.requiresSameOrigin, true);
  assert.equal(policy?.idempotency, true);
});
