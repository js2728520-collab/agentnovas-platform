import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadMaintenanceAiUsage,
  maintenanceAiUsageUserRef,
  parseMaintenanceAiUsageWindow,
} from "../lib/maintenance-ai-usage.ts";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("AI usage window defaults to 30 UTC days and rejects unsafe ranges", () => {
  assert.deepEqual(parseMaintenanceAiUsageWindow(new URLSearchParams(), new Date("2026-08-24T13:30:00Z")), {
    from: "2026-07-26",
    to: "2026-08-24",
    timezone: "UTC",
  });
  assert.deepEqual(parseMaintenanceAiUsageWindow(new URLSearchParams("from=2026-08-01&to=2026-08-24"), new Date("2026-08-24T13:30:00Z")), {
    from: "2026-08-01",
    to: "2026-08-24",
    timezone: "UTC",
  });
  for (const query of [
    "from=2026-02-29&to=2026-03-01",
    "from=2026-08-25&to=2026-08-25",
    "from=2026-08-24&to=2026-08-01",
    "from=2026-05-26&to=2026-08-24",
    "from=2026-08-01",
  ]) {
    assert.throws(
      () => parseMaintenanceAiUsageWindow(new URLSearchParams(query), new Date("2026-08-24T13:30:00Z")),
      (error) => error?.code === "AI_USAGE_DATE_RANGE_INVALID" && error?.status === 400,
      query,
    );
  }
});

test("user dimension is stable and never returns the raw user identifier", () => {
  const first = maintenanceAiUsageUserRef("customer-secret-id-1");
  assert.equal(first, maintenanceAiUsageUserRef("customer-secret-id-1"));
  assert.match(first, /^USR-[A-F0-9]{12}$/);
  assert.doesNotMatch(first, /customer|secret|id-1/i);
  assert.notEqual(first, maintenanceAiUsageUserRef("customer-secret-id-2"));
});

test("AI usage report preserves exact metering, excludes cancellations from failure rate, and bounds dimensions", async () => {
  const calls = [];
  const metric = (overrides = {}) => ({
    request_count: "6",
    succeeded_count: "2",
    failed_count: "2",
    cancelled_count: "1",
    processing_count: "1",
    input_tokens: "9007199254740993",
    output_tokens: "44",
    settled_credits: "900719925474099312345",
    released_count: "1",
    ...overrides,
  });
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      assert.match(sql, /maintenance-ai-usage:report/);
      return { rows: [
        metric({ dimension_key: "summary" }),
        metric({ dimension_key: "day", group_key: "2026-08-24", request_count: "3" }),
        metric({ dimension_key: "organization", group_key: "org-1", group_label: "上海分公司" }),
        ...Array.from({ length: 51 }, (_, index) => metric({ dimension_key: "user", group_key: `private-user-${index}`, request_count: String(100 - index) })).reverse(),
        metric({ dimension_key: "model", group_key: "revision-1", provider_name: "OpenAI Compatible", model_name: "gpt-fixture" }),
        metric({ dimension_key: "agent", group_key: "report" }),
        metric({ dimension_key: "function", group_key: "assistant_message" }),
      ] };
    },
  };

  const report = await loadMaintenanceAiUsage(database, {
    from: "2026-08-23",
    to: "2026-08-24",
    timezone: "UTC",
  });

  assert.deepEqual(report.period, { from: "2026-08-23", to: "2026-08-24", timezone: "UTC" });
  assert.deepEqual(report.pricing, { status: "decision_required", blocker: "P-08" });
  assert.equal(report.summary.recordedFailureRate, 0.5);
  assert.equal(report.summary.recordedFailureCount, 2);
  assert.deepEqual(report.summary.organizationAttribution, {
    capturedAtRequest: 0,
    legacyCurrentBackfill: 0,
    legacyUnattributed: 0,
  });
  assert.equal(report.summary.inputTokens, "9007199254740993");
  assert.equal(report.summary.settledCredits, "900719925474099312345");
  assert.equal(report.byDay.length, 2, "missing UTC days are filled with zero metrics");
  assert.equal(report.byDay[0].key, "2026-08-23");
  assert.equal(report.byDay[0].requestCount, 0);
  assert.equal(report.byDay[1].requestCount, 3);
  assert.equal(report.byUser.data.length, 50);
  assert.equal(report.byUser.truncated, true);
  assert.equal(report.byUser.data[0].key, maintenanceAiUsageUserRef("private-user-0"), "dimension order is deterministic even if UNION rows are not ordered");
  assert.doesNotMatch(JSON.stringify(report), /private-user-/);
  assert.deepEqual(report.byOrganization.data[0].label, "上海分公司");
  assert.equal(report.byModel.data[0].key, "revision-1");
  assert.equal(report.byModel.data[0].providerName, "OpenAI Compatible");
  assert.equal(report.byModel.data[0].modelName, "gpt-fixture");
  assert.equal(report.timeBasis, "request_created_at");
  assert.deepEqual(report.population.excludes, ["preflight_rejections", "user_cancellations", "processing_requests"]);
  assert.equal(calls.length, 1, "all report dimensions share one statement-level timeout");
  for (const call of calls) {
    assert.deepEqual(call.values.slice(0, 2), ["2026-08-23", "2026-08-24"]);
    assert.match(call.sql, /maintenance_ai_usage_events_safe/);
    assert.match(call.sql, /created_at >= \(\$1::date::timestamp AT TIME ZONE 'UTC'\)/);
    assert.match(call.sql, /created_at < \(\(\$2::date \+ 1\)::timestamp AT TIME ZONE 'UTC'\)/);
  }
});

test("Maintenance usage route, permission, view, and UI are isolated and secret-safe", async () => {
  const [migration, grants, route, service, ui, app, nav, routeContract, rbac] = await Promise.all([
    source("../postgres/migrations/0074_maintenance_ai_usage_analytics.sql"),
    source("../deploy/postgres/least-privilege-roles.sql"),
    source("../app/api/maintenance/ai-usage/route.maintenance.ts"),
    source("../lib/maintenance-ai-usage.ts"),
    source("../apps/maintenance/ui/ai-usage-workspace.tsx"),
    source("../apps/maintenance/ui/maintenance-app.tsx"),
    source("../apps/maintenance/ui/maintenance-information-architecture.ts"),
    source("../app/riverton-route-contract.ts"),
    source("../lib/rbac.ts"),
  ]);

  assert.match(migration, /maint\.ai_usage\.view/);
  assert.match(migration, /VIEW maintenance_ai_usage_events_safe\s+WITH \(security_barrier = true\)/i);
  assert.match(migration, /profile_revision_id/);
  assert.match(migration, /md5\(request\.user_id\) AS user_pseudonym_source/);
  assert.match(migration, /organization_attribution_mode/);
  assert.match(migration, /AI_REQUEST_CANCELLED/);
  assert.doesNotMatch(migration.match(/CREATE OR REPLACE VIEW maintenance_ai_usage_events_safe[\s\S]*?;/i)?.[0] ?? "", /payload_sha256|result_json|error_message|provider_request_id|usage_id|encrypted_api_key|email|phone/i);
  assert.match(grants, /GRANT SELECT ON maintenance_ai_usage_events_safe TO agentnovas_maint_web/i);
  const maintenanceStart = grants.indexOf("-- Maintenance receives");
  const maintenanceEnd = grants.indexOf("-- Execution service", maintenanceStart);
  const maintenanceGrants = grants.slice(maintenanceStart, maintenanceEnd > maintenanceStart ? maintenanceEnd : undefined);
  assert.doesNotMatch(maintenanceGrants.match(/GRANT SELECT ON[\s\S]*?TO agentnovas_maint_web;/i)?.[0] ?? "", /client_ai_inference_requests|ai_credit_reservations|customer_attributions/i);

  assert.match(route, /requireAccessPermission\(request,\s*"maint\.ai_usage\.view"\)/);
  assert.match(route, /cache-control"\s*:\s*"no-store"/i);
  assert.doesNotMatch(service, /ai_usage_daily/);
  assert.doesNotMatch(service, /SELECT\s+\*/i);
  assert.match(service, /REPEATABLE READ READ ONLY/);
  assert.match(service, /statement_timeout='5s'/);
  assert.match(service, /WITH filtered AS MATERIALIZED/);
  assert.match(service, /timeBasis:\s*"request_created_at"/);
  assert.match(ui, /AI 用量与可靠性/);
  assert.match(ui, /应用日期/);
  assert.match(ui, /恢复默认 30 天/);
  assert.match(ui, /已记录非取消失败率/);
  assert.match(ui, /function isValidDateInputValue/);
  assert.match(ui, /setDraft\(nextDraft\)/);
  assert.match(ui, /setApplied\(nextApplied\)/);
  assert.match(ui, /manualRefreshPending\.current/);
  assert.match(ui, /disabled=\{resource\.loading\}/);
  assert.doesNotMatch(ui, /confirm\s*\(|window\.confirm|alert\s*\(/);
  assert.match(app, /AiUsageWorkspace/);
  assert.match(nav, /\/ai-strategy\?tab=usage/);
  assert.match(routeContract, /"ai-usage"/);
  assert.match(rbac, /maint\.ai_usage\.view/);
  const inventory = await import("../lib/api-route-inventory.ts");
  const policy = inventory.API_ROUTE_INVENTORY.find((entry) => entry.method === "GET" && entry.route === "/api/maintenance/ai-usage");
  assert.equal(policy?.pii, "masked");
  assert.equal(policy?.sensitivity, "sensitive");
  assert.equal(policy?.mfa, "recent");
});
