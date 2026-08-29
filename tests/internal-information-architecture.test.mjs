import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  operationsPrimaryNavigation,
  resolveOperationsCommercialTab,
  resolveOperationsCustomerTab,
  resolveOperationsDashboardTab,
  resolveOperationsGovernanceTab,
  resolveOperationsSection,
  resolveOperationsTradingTab,
} from "../apps/operations/ui/operations-information-architecture.ts";
import {
  maintenancePrimaryNavigation,
  resolveMaintenanceAiStrategyTab,
  resolveMaintenanceConfigurationTab,
  resolveMaintenanceIntegrationTab,
  resolveMaintenanceReleaseTab,
  resolveMaintenanceSection,
  resolveMaintenanceSystemTab,
} from "../apps/maintenance/ui/maintenance-information-architecture.ts";
import { isRivertonPagePath } from "../app/riverton-route-contract.ts";

test("Operations primary navigation is limited to five business centers", () => {
  const items = operationsPrimaryNavigation.flatMap((group) => group.items);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => item.label), ["运营看板", "客户与账户", "交易与风控", "商业与财务", "运营治理"]);
  assert.deepEqual(items.map((item) => item.href), ["/", "/customers", "/trading-operations", "/commercial", "/governance"]);
});

test("Operations legacy routes resolve into a hub and safe tab", () => {
  assert.equal(resolveOperationsSection("/team"), "dashboard");
  assert.equal(resolveOperationsSection("/accounts"), "governance");
  assert.equal(resolveOperationsSection("/live-routing"), "trading");
  assert.equal(resolveOperationsSection("/credits"), "commercial");
  assert.equal(resolveOperationsSection("/access/audit"), "governance");

  assert.equal(resolveOperationsDashboardTab(null, "team", ["overview", "targets"]), "targets");
  assert.equal(resolveOperationsDashboardTab("invalid", "overview", ["overview"]), "overview");
  assert.equal(resolveOperationsCustomerTab(null, "customers", ["customers"]), "customers");
  assert.equal(resolveOperationsCustomerTab("not-a-tab", "customers", ["customers"]), "customers");
  assert.equal(resolveOperationsTradingTab(null, "kill-switches", ["controls", "routing"]), "controls");
  assert.equal(resolveOperationsCommercialTab(null, "performance-statements", ["membership", "statements"]), "statements");
  assert.equal(resolveOperationsGovernanceTab(null, "accounts", ["operators"], []), "operators");
  assert.equal(resolveOperationsGovernanceTab(null, "access", ["access", "audit"], ["audit"]), "audit");
});

test("Maintenance primary navigation is limited to five business centers", () => {
  const items = maintenancePrimaryNavigation.flatMap((group) => group.items);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => item.label), ["系统运行", "AI 与策略", "外部集成", "平台配置", "发布与安全"]);
  assert.deepEqual(items.map((item) => item.href), ["/", "/ai-strategy", "/integrations", "/configurations", "/releases"]);
});

test("Maintenance legacy routes resolve into a hub and safe tab", () => {
  assert.equal(resolveMaintenanceSection("/health"), "system");
  assert.equal(resolveMaintenanceSection("/ai-usage"), "ai-strategy");
  assert.equal(resolveMaintenanceSection("/integrations/email"), "integrations");
  assert.equal(resolveMaintenanceSection("/settings/disclosures"), "configurations");
  assert.equal(resolveMaintenanceSection("/access/audit"), "releases");

  assert.equal(resolveMaintenanceSystemTab(null, "work-records", ["overview", "records"]), "records");
  assert.equal(resolveMaintenanceAiStrategyTab(null, "ai-usage", ["models", "usage"]), "usage");
  assert.equal(resolveMaintenanceIntegrationTab(null, "integrations", ["overview", "email"], ["email"]), "email");
  assert.equal(resolveMaintenanceConfigurationTab(null, "settings", ["versions", "platform"]), "platform");
  assert.equal(resolveMaintenanceReleaseTab(null, "access", ["releases", "access", "authorization-audit"], ["audit"]), "authorization-audit");
  assert.equal(resolveMaintenanceReleaseTab("not-a-tab", "releases", ["releases"]), "releases");
});

test("route contract accepts the new hubs and preserves existing stable aliases", () => {
  for (const path of ["/trading-operations", "/commercial", "/governance", "/customers", "/credits", "/access/audit"]) {
    assert.equal(isRivertonPagePath("operations", path), true, path);
  }
  for (const path of ["/ai-strategy", "/integrations", "/configurations", "/releases", "/health", "/settings/disclosures"]) {
    assert.equal(isRivertonPagePath("maintenance", path), true, path);
  }
  assert.equal(isRivertonPagePath("client", "/commercial"), false);
  assert.equal(isRivertonPagePath("operations", "/ai-strategy"), false);
  assert.equal(isRivertonPagePath("maintenance", "/governance"), false);
});

test("internal calls to action use canonical hubs while legacy paths remain aliases only", async () => {
  const operations = await Promise.all([
    "operations-overview.tsx",
    "data-center-workspace.tsx",
    "deposits-workspace.tsx",
    "finance-workspace.tsx",
    "membership-orders-workspace.tsx",
    "performance-statements-workspace.tsx",
  ].map((file) => readFile(new URL(`../apps/operations/ui/${file}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n"));
  const maintenance = await Promise.all([
    readFile(new URL("../apps/maintenance/ui/integrations-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/maintenance/ui/emergency-control-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/maintenance/ui/commercial-disclosures-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/maintenance/trading/emergency-stop/route.maintenance.ts", import.meta.url), "utf8"),
  ]).then((parts) => parts.join("\n"));

  assert.match(operations, /\/commercial\?tab=deposits/);
  assert.match(operations, /\/governance\?tab=approvals/);
  assert.doesNotMatch(operations, /href="\/(?:membership-orders|performance-statements|credits|deposits|ledger|finance|approvals)"/);
  assert.match(maintenance, /\/integrations\?tab=demo/);
  assert.match(maintenance, /\/configurations\?tab=platform/);
  assert.doesNotMatch(maintenance, /href="\/(?:settings|safety|audit|models|ai-usage|work-records|health|integrations\/(?:sources|email|payments|demo-exchanges))"/);
});

test("internal hub tabs override the sidebar navigation grid", async () => {
  const css = await readFile(new URL("../app/riverton-console.css", import.meta.url), "utf8");
  assert.match(css, /\.rc-console \.rc-hub-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(css, /\.rc-console \.rc-hub-tabs a\s*\{[^}]*min-height:\s*38px;[^}]*padding:\s*9px 13px;/s);
});
