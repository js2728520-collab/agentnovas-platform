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

test("maintenance emergency control is RBAC protected and limited to official Paper access", async () => {
  const route = await read("app/api/maintenance/trading/emergency-stop/route.maintenance.ts");
  const paperRepository = await read("lib/official-paper-repository.ts");
  const implementation = `${route}\n${paperRepository}`;
  assert.match(route, /maint\.emergency_pause\.execute/);
  assert.match(route, /必须填写事故或处置说明/);
  assert.match(route, /事故或处置说明不能超过 240 个字符/);
  assert.match(route, /emergencyScopeForAccess/);
  assert.match(implementation, /official_paper_portfolios/);
  assert.match(implementation, /official_paper_positions/);
  assert.match(implementation, /access_status/);
  assert.match(implementation, /close_only/);
  assert.match(implementation, /read_only/);
  assert.match(implementation, /TRADING_EMERGENCY_STOPPED/);
  assert.match(route, /paperAccessOnly/);
  assert.doesNotMatch(route, /exchangeAccounts|\btrades\b|closeOkxDemoTrade|trading-emergency-close|closePositions/);
  assert.doesNotMatch(route, /strategySubscriptions|platformStrategySubscriptions/);
});

test("platform strategy activation respects platform and organization emergency scopes", async () => {
  const { emergencyScopeForAccess } = await import("../lib/trading-emergency-scope.ts");
  const follow = await read("app/api/platform-strategies/[code]/follow/route.client.ts");
  const communityFollow = await read("app/api/strategy-marketplace/[id]/follow/route.client.ts");
  const communityLifecycle = await read("app/api/strategy-subscriptions/[id]/route.client.ts");
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
  const app = await Promise.all([read("apps/maintenance/ui/maintenance-app.tsx"), read("apps/maintenance/ui/maintenance-information-architecture.ts")]).then((parts) => parts.join("\n"));
  const workspace = await read("apps/maintenance/ui/emergency-control-workspace.tsx");
  assert.match(app, /href: "\/releases\?tab=safety"/);
  assert.match(app, /maint\.emergency_pause\.execute/);
  assert.doesNotMatch(workspace, /InlineAuditReasonField|hasValidAuditReason/);
  assert.match(workspace, /事故或处置说明（业务字段）/);
  assert.doesNotMatch(workspace, /ConfirmActionDialog/);
  assert.match(workspace, /官方 Paper/);
  assert.match(workspace, /平台 Demo/);
  assert.match(workspace, /\/integrations\?tab=demo/);
  assert.match(workspace, /审批|审计|原因/);
  assert.doesNotMatch(workspace, /pause_demo_close|closePositions|处理 OKX Demo 仓位|自动平仓/);
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
  const maintenanceRoute = await read("app/api/maintenance/platform-settings/route.maintenance.ts");
  const publicRoute = await read("app/api/platform/settings/route.client.ts");
  const workspace = await read("apps/maintenance/ui/platform-settings-workspace.tsx");
  assert.match(maintenanceRoute, /maint\.feature_flags\.manage/);
  assert.match(maintenanceRoute, /automaticAuditReason/);
  assert.match(publicRoute, /publicPlatformSettings/);
  assert.doesNotMatch(publicRoute, /security|billing|integrations/);
  assert.match(workspace, /Telegram 客服链接/);
  assert.match(workspace, /维护公告/);
});

test("client support entry uses Riverton branding and never fakes a ticket submission", async () => {
  // 品牌断言原本落在遗留 SPA 的外壳上；外壳现在是 client-portal-shell。
  const client = await read("apps/client/ui/client-portal-shell.tsx");
  const support = await read("apps/client/ui/support-workspace.tsx");
  const layout = await read("app/layout.tsx");
  const metadata = await read("lib/riverton-metadata.ts");
  assert.match(client, /Riverton Capital/);
  assert.match(support, /\/api\/platform\/settings/);
  assert.match(support, /telegramSupportUrl/);
  assert.match(layout, /rivertonMetadata/);
  assert.match(metadata, /Riverton Capital 客户端/);
  assert.match(support, /supportEmail/);
  // 未配置的单个渠道不渲染空卡片；只有全部渠道缺失时才显示一个整体空状态。
  assert.match(support, /hasChannel \?/);
  assert.doesNotMatch(support, /Telegram 尚未配置，不提供替代账号或验证码/);
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
