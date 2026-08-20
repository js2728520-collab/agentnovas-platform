import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("root page dispatches one codebase to the three audience applications", async () => {
  const source = await read("app/page.tsx");
  assert.doesNotMatch(source, /^"use client";/);
  assert.match(source, /resolveAppAudienceStrict/);
  assert.match(source, /if \(!audience\) notFound\(\)/);
  assert.match(source, /CurrentApp/);
  assert.doesNotMatch(source, /^import .*@\/apps\//m);
  assert.match(source, /@\/app\/audience\/current-root/);
});

test("stable routes use the same audience dispatcher and reject wrong applications", async () => {
  const source = await read("app/[...segments]/page.tsx");
  const dispatcher = await read("app/riverton-route.tsx");
  assert.match(source, /RivertonRoute/);
  assert.match(source, /notFound/);
  assert.match(source, /segments/);
  assert.match(dispatcher, /resolveAppAudienceStrict/);
  assert.match(dispatcher, /if \(!audience\) notFound\(\)/);
  assert.match(dispatcher, /\["wallet", "membership", "paper"\]\.includes\(root\)/);
  assert.match(dispatcher, /"membership-orders", "performance-statements"/);
  assert.match(dispatcher, /"email", "payments", "demo-exchanges"/);
  assert.doesNotMatch(dispatcher, /^import .*@\/apps\//m);
  assert.match(dispatcher, /CurrentApp/);
});

test("audience entries own their CSS while the root layout stays minimal", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /\.\/base\.css/);
  assert.doesNotMatch(layout, /market-terminal|membership-center|riverton-console|\.\/globals\.css/);
  assert.doesNotMatch(layout, /LocaleGuard/);
  const client = await read("app/audience/client-root.tsx");
  const clientPortal = await read("app/audience/client-portal-root.tsx");
  const clientWorkspace = await read("app/audience/client-workspace-root.tsx");
  const workspacePage = await read("app/workspace/page.tsx");
  const operations = await read("app/audience/operations-root.tsx");
  const maintenance = await read("app/audience/maintenance-root.tsx");
  assert.doesNotMatch(client, /\.css["']/);
  assert.match(client, /import\("\.\/client-portal-root"\)/);
  assert.doesNotMatch(client, /client-workspace-root/);
  assert.match(workspacePage, /ClientWorkspaceRoot/);
  assert.match(workspacePage, /resolveAppAudienceStrict/);
  assert.match(workspacePage, /audience !== "client"/);
  assert.match(clientPortal, /riverton-console\.css/);
  assert.match(clientWorkspace, /globals-beta\.css/);
  assert.doesNotMatch(clientWorkspace, /["']\.\.\/globals\.css["']/);
  assert.match(clientWorkspace, /market-terminal\.css/);
  assert.match(clientWorkspace, /membership-center\.css/);
  assert.match(clientWorkspace, /LocaleGuard/);
  assert.match(operations, /riverton-console\.css/);
  assert.match(maintenance, /riverton-console\.css/);
  assert.doesNotMatch(operations + maintenance, /globals|market-terminal|membership-center/);
  const config = await read("next.config.ts");
  assert.match(config, /resolveAlias/);
  assert.match(config, /@\/app\/audience\/current-root/);
});

test("metadata identifies each audience and keeps internal consoles out of search", async () => {
  const { rivertonMetadata } = await import("../lib/riverton-metadata.ts");
  const client = rivertonMetadata("client");
  const operations = rivertonMetadata("operations");
  const maintenance = rivertonMetadata("maintenance");
  assert.match(String(client.title), /客户端/);
  assert.match(String(operations.title), /运营端/);
  assert.match(String(maintenance.title), /运维端/);
  assert.equal(operations.robots?.index, false);
  assert.equal(maintenance.robots?.index, false);
  assert.equal(client.robots?.index, true);
  assert.doesNotMatch(String(operations.description), /non-custodial AI quant trading platform/i);
});

test("internal applications use permission-driven navigation and login without registration", async () => {
  const shell = await read("packages/ui/src/console-shell.tsx");
  const login = await read("packages/ui/src/app-login.tsx");
  const operations = await read("apps/operations/ui/operations-app.tsx");
  const maintenance = await read("apps/maintenance/ui/maintenance-app.tsx");
  assert.match(shell, /visibleNavigation\(navigation, access\.permissions\)/);
  assert.match(login, /allowRegistration/);
  assert.match(operations, /allowRegistration=\{false\}/);
  assert.match(maintenance, /allowRegistration=\{false\}/);
  for (const path of ["app/api/auth/register/route.ts", "app/api/auth/forgot-password/route.ts"]) {
    const endpoint = await read(path);
    assert.match(endpoint, /currentRequestAudience\(request\) !== "client"/);
    assert.match(endpoint, /status: 404/);
  }
});

test("internal login completes required TOTP enrollment and verification", async () => {
  const login = await read("packages/ui/src/app-login.tsx");
  assert.match(login, /mfaEnrollmentRequired/);
  assert.match(login, /\/api\/auth\/mfa\/enroll\/start/);
  assert.match(login, /\/api\/auth\/mfa\/enroll\/confirm/);
  assert.match(login, /\/api\/auth\/mfa\/verify/);
  assert.match(login, /recoveryCodes/);
  assert.match(login, /autoComplete="one-time-code"/);
});

test("shared console navigation is hydration-safe and keyboard-contained", async () => {
  const shell = await read("packages/ui/src/console-shell.tsx");
  assert.match(shell, /usePathname/);
  assert.match(shell, /rc-skip-link/);
  assert.match(shell, /aria-modal/);
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /event\.key === "Tab"/);
  assert.match(shell, /rc-console-backdrop/);
  assert.match(shell, /returnButton\?\.focus/);
  assert.match(shell, /aria-label="面包屑"/);
  assert.match(shell, /aria-current="page"/);
  assert.match(shell, /currentItem/);
  assert.doesNotMatch(shell, /typeof window === "undefined" \? "\/"/);
});

test("shared request hooks cancel obsolete reads instead of committing stale data", async () => {
  const dataHook = await read("packages/ui/src/use-api-data.ts");
  const sessionHook = await read("packages/ui/src/use-app-session.ts");
  for (const source of [dataHook, sessionHook]) {
    assert.match(source, /AbortController/);
    assert.match(source, /signal:/);
    assert.match(source, /abort\(\)/);
  }
  assert.match(dataHook, /requestSequence/);
});

test("app router owns audience-neutral loading, error and not-found states", async () => {
  const loading = await read("app/loading.tsx");
  const error = await read("app/error.tsx");
  const globalError = await read("app/global-error.tsx");
  const notFound = await read("app/not-found.tsx");
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-live="polite"/);
  assert.match(error, /^"use client";/);
  assert.match(error, /reset\(\)/);
  assert.match(globalError, /^"use client";/);
  assert.match(globalError, /<html lang="zh-CN">/);
  assert.match(notFound, /页面不存在/);
  for (const source of [loading, error, globalError, notFound]) {
    assert.doesNotMatch(source, /@\/apps\//);
  }
});

test("client exposes stable wallet, deposit and notification workspaces", async () => {
  const source = await read("apps/client/ui/client-portal.tsx");
  assert.match(source, /WalletWorkspace/);
  assert.match(source, /DepositWorkspace/);
  assert.match(source, /NotificationWorkspace/);
});

test("client exposes stable membership, credits, paper, and trading-hall workspaces", async () => {
  const dispatcher = await read("app/riverton-route.tsx");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const navigation = await read("apps/client/ui/client-portal-shell.tsx");
  for (const route of ["membership", "credits", "paper", "trading-hall"]) {
    assert.match(dispatcher, new RegExp(`CLIENT_ROUTES[\\s\\S]*["']${route}["']`));
  }
  assert.match(portal, /MembershipExperience/);
  assert.match(portal, /TradingExperience/);
  assert.match(portal, /client\.membership\.view/);
  assert.match(portal, /client\.credits\.view/);
  assert.match(portal, /client\.paper\.view/);
  assert.match(navigation, /href: "\/membership"/);
  assert.match(navigation, /href: "\/paper"/);
  assert.match(navigation, /href: "\/trading-hall"/);
});

test("client workspaces bind to real wallet and notifications while deposits remain Beta closed", async () => {
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");
  const notifications = await read("apps/client/ui/notification-workspace.tsx");
  assert.match(wallet, /\/api\/wallet\/balances/);
  assert.match(wallet, /\/api\/wallet\/ledger/);
  assert.match(deposits, /Beta/);
  assert.match(deposits, /暂不开放/);
  assert.doesNotMatch(deposits, /fetch\(|\/api\/wallet\/deposit-orders/);
  assert.match(notifications, /\/api\/notifications\/inbox/);
  assert.match(notifications, /ClientNotificationSettings/);
});

test("access center can publish approved draft roles with an audited reason", async () => {
  const center = await read("packages/ui/src/access-center.tsx");
  const publish = await read("app/api/access/roles/[id]/publish/route.ts");
  assert.match(center, /kind: "publish"/);
  assert.match(center, /role\.status === "draft"/);
  assert.match(publish, /必须填写发布原因/);
  assert.match(publish, /authorization_audit_events/);
  assert.match(center, /\/api\/access\/role-templates/);
  assert.match(center, /template_publish/);
});

test("maintenance model response view omits full endpoints and key material", async () => {
  const { maintenanceLlmProfileView } = await import("../lib/maintenance-model-view.ts");
  const view = maintenanceLlmProfileView({
    id: "profile-1",
    name: "Primary",
    providerName: "provider",
    baseUrl: "https://secret-endpoint.example/v1",
    modelName: "model",
    maskedApiKey: "sk-****",
    hasApiKey: true,
    enabled: true,
    currentRevisionId: "revision-1",
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(view).sort(), ["currentRevisionId", "enabled", "hasSecret", "id", "modelName", "name", "providerName", "updatedAt"]);
  assert.equal(view.hasSecret, true);
  assert.doesNotMatch(JSON.stringify(view), /secret-endpoint|sk-\*\*\*\*/);
});

test("payment connectivity tests require an explicit true feature switch", async () => {
  const source = await read("app/api/maintenance/payment-providers/[id]/test/route.ts");
  assert.match(source, /PAYMENT_PROVIDER_TESTS_ENABLED !== "true"/);
  assert.match(source, /503/);
  assert.match(source, /maintenanceReason/);
});

test("maintenance connectivity tests require reasons while Payment stays read-only in Beta", async () => {
  for (const path of [
    "app/api/admin/agent-role-bindings/test/route.ts",
    "app/api/admin/runtime-explanation-bindings/test/route.ts",
    "app/api/maintenance/email/test/route.ts",
  ]) {
    assert.match(await read(path), /maintenanceReason/);
  }
  assert.match(await read("apps/maintenance/ui/models-workspace.tsx"), /kind: "test"/);
  assert.match(await read("apps/maintenance/ui/email-integration-workspace.tsx"), /ConfirmActionDialog/);
  const payment = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.match(payment, /BETA POLICY: DISABLED/);
  assert.doesNotMatch(payment, /kind: "test"|kind: "status"|ConfirmActionDialog/);
});

test("maintenance model workspaces separate read access from write controls", async () => {
  const source = await read("apps/maintenance/ui/maintenance-app.tsx");
  assert.match(source, /href: "\/models"[\s\S]*maint\.system_health\.view/);
  assert.match(source, /route === "models" \? \["maint\.system_health\.view"/);
  assert.match(source, /canManageProfiles/);
  assert.match(source, /canManageBindings/);
});
