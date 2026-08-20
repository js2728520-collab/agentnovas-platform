import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("root page dispatches one codebase to the three audience applications", async () => {
  const source = await read("app/page.tsx");
  assert.doesNotMatch(source, /^"use client";/);
  assert.match(source, /resolveAppAudienceStrict/);
  assert.match(source, /if \(!audience\) notFound\(\)/);
  assert.match(source, /ClientApp/);
  assert.match(source, /OperationsApp/);
  assert.match(source, /MaintenanceApp/);
});

test("stable routes use the same audience dispatcher and reject wrong applications", async () => {
  const source = await read("app/[...segments]/page.tsx");
  const dispatcher = await read("app/riverton-route.tsx");
  assert.match(source, /RivertonRoute/);
  assert.match(source, /notFound/);
  assert.match(source, /segments/);
  assert.match(dispatcher, /resolveAppAudienceStrict/);
  assert.match(dispatcher, /if \(!audience\) notFound\(\)/);
  assert.match(dispatcher, /root !== "wallet" && segments\.length > 1/);
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

test("client exposes stable wallet, deposit and notification workspaces", async () => {
  const source = await read("apps/client/ui/client-portal.tsx");
  assert.match(source, /WalletWorkspace/);
  assert.match(source, /DepositWorkspace/);
  assert.match(source, /NotificationWorkspace/);
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

test("maintenance connectivity tests require reasons and use confirmation dialogs", async () => {
  for (const path of [
    "app/api/admin/agent-role-bindings/test/route.ts",
    "app/api/admin/runtime-explanation-bindings/test/route.ts",
    "app/api/maintenance/email/test/route.ts",
  ]) {
    assert.match(await read(path), /maintenanceReason/);
  }
  assert.match(await read("apps/maintenance/ui/models-workspace.tsx"), /kind: "test"/);
  assert.match(await read("apps/maintenance/ui/email-integration-workspace.tsx"), /ConfirmActionDialog/);
  assert.match(await read("apps/maintenance/ui/payment-integration-workspace.tsx"), /kind: "test"/);
});

test("maintenance model workspaces separate read access from write controls", async () => {
  const source = await read("apps/maintenance/ui/maintenance-app.tsx");
  assert.match(source, /href: "\/models"[\s\S]*maint\.system_health\.view/);
  assert.match(source, /route === "models" \? \["maint\.system_health\.view"/);
  assert.match(source, /canManageProfiles/);
  assert.match(source, /canManageBindings/);
});
