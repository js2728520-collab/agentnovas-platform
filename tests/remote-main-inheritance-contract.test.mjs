import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("inherits scoped emergency-stop storage in the PostgreSQL migration chain", async () => {
  const migration = await read("postgres/migrations/0019_remote_main_safety_support.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "trading_emergency_stops"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "platform_settings"/);
  assert.match(migration, /UNIQUE \("scope_key"\)/);
  assert.match(migration, /CHECK \("scope_type" IN \('platform', 'organization'\)\)/);
});

test("maintenance emergency control is RBAC protected, reasoned and demo-only", async () => {
  const route = await read("app/api/maintenance/trading/emergency-stop/route.ts");
  const close = await read("lib/trading-emergency-close.ts");
  assert.match(route, /maint\.emergency_pause\.execute/);
  assert.match(route, /必须填写紧急暂停原因/);
  assert.match(route, /emergencyScopeForAccess/);
  assert.match(route, /executionVenue === "okx_demo"/);
  assert.match(route, /account\.environment === "demo"/);
  assert.doesNotMatch(close, /environment === "live"|place.*Live/i);
});

test("platform strategy activation respects platform and organization emergency scopes", async () => {
  const { emergencyScopeForAccess } = await import("../lib/trading-emergency-scope.ts");
  const follow = await read("app/api/platform-strategies/[code]/follow/route.ts");
  const communityFollow = await read("app/api/strategy-marketplace/[id]/follow/route.ts");
  const communityLifecycle = await read("app/api/strategy-subscriptions/[id]/route.ts");
  const emergency = await read("lib/trading-emergency.ts");
  assert.deepEqual(emergencyScopeForAccess("PLATFORM", null), { scopeKey: "platform", scopeType: "platform", organizationId: null });
  assert.deepEqual(emergencyScopeForAccess("ORGANIZATION", "org-1"), { scopeKey: "organization:org-1", scopeType: "organization", organizationId: "org-1" });
  assert.equal(emergencyScopeForAccess("ORGANIZATION", null), null);
  assert.match(follow, /isCustomerTradingEmergencyStopped/);
  assert.match(follow, /TRADING_EMERGENCY_STOPPED/);
  assert.match(communityFollow, /isCustomerTradingEmergencyStopped/);
  assert.match(communityLifecycle, /action === "resume"[^\n]+isCustomerTradingEmergencyStopped/);
  assert.match(emergency, /organizationEmergencyScopeKey/);
  assert.match(emergency, /scopeKeys/);
});

test("maintenance exposes explicit emergency controls through its own navigation", async () => {
  const app = await read("apps/maintenance/ui/maintenance-app.tsx");
  const workspace = await read("apps/maintenance/ui/emergency-control-workspace.tsx");
  assert.match(app, /href: "\/safety"/);
  assert.match(app, /maint\.emergency_pause\.execute/);
  assert.match(workspace, /ConfirmActionDialog/);
  assert.match(workspace, /OKX Demo/);
  assert.match(workspace, /审批|审计|原因/);
});

test("support configuration only accepts allowlisted Telegram HTTPS URLs", async () => {
  const { normalizeTelegramSupportUrl } = await import("../lib/platform-settings-contract.ts");
  assert.equal(normalizeTelegramSupportUrl("https://t.me/riverton_support"), "https://t.me/riverton_support");
  assert.equal(normalizeTelegramSupportUrl("https://telegram.me/riverton_support"), "https://telegram.me/riverton_support");
  assert.equal(normalizeTelegramSupportUrl("http://t.me/riverton_support"), "");
  assert.equal(normalizeTelegramSupportUrl("https://evil.example/riverton_support"), "");
  assert.equal(normalizeTelegramSupportUrl("javascript:alert(1)"), "");
});

test("maintenance owns support settings while the client receives a public safe view", async () => {
  const maintenanceRoute = await read("app/api/maintenance/platform-settings/route.ts");
  const publicRoute = await read("app/api/platform/settings/route.ts");
  const workspace = await read("apps/maintenance/ui/platform-settings-workspace.tsx");
  assert.match(maintenanceRoute, /maint\.feature_flags\.manage/);
  assert.match(maintenanceRoute, /maintenanceReason/);
  assert.match(publicRoute, /publicPlatformSettings/);
  assert.doesNotMatch(publicRoute, /security|billing|integrations/);
  assert.match(workspace, /Telegram 客服链接/);
  assert.match(workspace, /维护公告/);
});

test("client support entry uses Riverton branding and never fakes a ticket submission", async () => {
  const client = await read("app/client-app.tsx");
  const support = await read("app/support-floating.tsx");
  const layout = await read("app/layout.tsx");
  const metadata = await read("lib/riverton-metadata.ts");
  assert.match(client, /\/api\/platform\/settings/);
  assert.match(client, /telegramSupportUrl/);
  assert.match(client, /Riverton Capital/);
  assert.match(layout, /rivertonMetadata/);
  assert.match(metadata, /Riverton Capital 客户端/);
  assert.match(support, /supportEmail/);
  assert.match(support, /Telegram 客服链接尚未配置/);
  assert.doesNotMatch(support, /提交工单|Create ticket/);
});

test("the inherited public settings surface keeps browser security headers enabled", async () => {
  const config = await read("next.config.ts");
  assert.match(config, /poweredByHeader:\s*false/);
  assert.match(config, /X-Content-Type-Options/);
  assert.match(config, /X-Frame-Options/);
  assert.match(config, /Referrer-Policy/);
  assert.match(config, /Permissions-Policy/);
});
