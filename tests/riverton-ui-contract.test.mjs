import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readBytes = (path) => readFile(new URL(`../${path}`, import.meta.url));

test("root page dispatches one codebase to the three audience applications", async () => {
  const source = await read("app/page.tsx");
  assert.doesNotMatch(source, /^"use client";/);
  assert.match(source, /resolveAppAudienceStrict/);
  assert.match(source, /if \(!audience\) notFound\(\)/);
  assert.match(source, /CurrentApp/);
  assert.doesNotMatch(source, /^import .*@\/apps\//m);
  assert.match(source, /@\/app\/audience\/current-root/);
});

test("client root restores the public landing before any authenticated portal guard", async () => {
  const root = await read("app/audience/client-root.tsx");
  const landingRoot = await read("app/audience/client-landing-root.tsx");
  const landing = await read("apps/client/ui/client-public-landing.tsx");
  assert.match(root, /segments\.length === 0/);
  assert.match(root, /import\("\.\/client-landing-root"\)/);
  assert.ok(
    root.indexOf("segments.length === 0") < root.indexOf('import("./client-portal-root")'),
    "the public Client root must dispatch before the authenticated portal",
  );
  assert.match(landingRoot, /ClientPublicLanding/);
  assert.match(landingRoot, /apps\/client\/ui\/client-public-landing/);
  assert.match(landing, /export function ClientPublicLanding/);
  assert.match(landing, /\/login\?next=/);
  assert.match(landing, /import\("\.\/client-public-landing-locales"\)/);
  assert.doesNotMatch(landing, /@\/app\/i18n-runtime/);
  assert.match(landing, /id="landing-main" tabIndex=\{-1\}/);
  assert.doesNotMatch(landingRoot, /@\/app\/client-app/);
});

test("client surfaces and metadata use the supplied Riverton Capital brand assets", async () => {
  const [landing, shell, login, metadata, consoleCss, clientCss, logo, icon] = await Promise.all([
    read("apps/client/ui/client-public-landing.tsx"),
    read("packages/ui/src/console-shell.tsx"),
    read("packages/ui/src/app-login.tsx"),
    read("lib/riverton-metadata.ts"),
    read("app/riverton-console.css"),
    read("apps/client/ui/client-public-landing.module.css"),
    readBytes("public/riverton-capital-logo.png"),
    readBytes("public/riverton-capital-icon.png"),
  ]);
  assert.equal(createHash("sha256").update(logo).digest("hex"), "cc15a314b6d7e8e3643a9cfcabb3b03a7a7cc8982ac911f16b1cf7022d4098d7");
  assert.ok(logo.length <= 200 * 1024, "the supplied logo must stay within the client raster budget");
  assert.ok(icon.length <= 200 * 1024, "the square favicon must stay within the client raster budget");
  for (const source of [landing, shell, login, metadata]) {
    assert.match(source, /riverton-capital-logo\.png|riverton-capital-icon\.png/);
  }
  assert.match(consoleCss, /\.rc-client \.rc-console-brand > img/);
  assert.match(consoleCss, /\.rc-auth-client \.rc-auth-brand > a img/);
  // 落地页重设计后顶栏改用 CSS Module。原来三条断言分别是：品牌 logo 有尺寸约束、
  // 登录按钮可见、「用户」按钮被 display:none 隐藏。
  //
  // 第三条现在更强了：那个按钮已被删除——它和「登录」调用同一个 navigate("login")，
  // 而且标签是写死的中文「用户」，在 7 语言页面里不翻译。重复 + i18n 缺陷，两条都成立。
  assert.match(clientCss, /\.brandLogo \{[^}]*width:/);
  assert.match(clientCss, /\.login,/);
  const landingSource = await read("apps/client/ui/client-public-landing.tsx");
  assert.doesNotMatch(landingSource, /top-user-guest|>用户</);
  const { rivertonMetadata } = await import("../lib/riverton-metadata.ts");
  assert.match(JSON.stringify(rivertonMetadata("client").icons), /riverton-capital-icon\.png/);
  assert.doesNotMatch(JSON.stringify(rivertonMetadata("operations").icons), /riverton-capital/);
  assert.doesNotMatch(JSON.stringify(rivertonMetadata("maintenance").icons), /riverton-capital/);
});

test("stable routes use the same audience dispatcher and reject wrong applications", async () => {
  const source = await read("app/[...segments]/page.tsx");
  const dispatcher = await read("app/riverton-route.tsx");
  const contract = await read("app/riverton-route-contract.ts");
  assert.match(source, /RivertonRoute/);
  assert.match(source, /notFound/);
  assert.match(source, /segments/);
  assert.match(dispatcher, /resolveAppAudienceStrict/);
  assert.match(dispatcher, /if \(!audience\) notFound\(\)/);
  assert.match(dispatcher, /isRivertonAppRoute/);
  assert.match(contract, /"membership-orders", "performance-statements"/);
  assert.match(contract, /"email", "payments", "demo-exchanges"/);
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
  const operations = await read("app/audience/operations-root.tsx");
  const maintenance = await read("app/audience/maintenance-root.tsx");
  assert.doesNotMatch(client, /\.css["']/);
  assert.match(client, /import\("\.\/client-portal-root"\)/);
  assert.doesNotMatch(client, /client-workspace-root/);
  assert.match(clientPortal, /riverton-console\.css/);
  // 债已还清：门户下所有界面的样式都在各自的 CSS Module 里，
  // globals-beta.css 只剩公开落地页在用。
  assert.doesNotMatch(clientPortal, /client-public-landing/);
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
  const operations = await Promise.all([read("apps/operations/ui/operations-app.tsx"), read("apps/operations/ui/navigation.ts")]).then((parts) => parts.join("\n"));
  const maintenance = await Promise.all([read("apps/maintenance/ui/maintenance-app.tsx"), read("apps/maintenance/ui/navigation.ts")]).then((parts) => parts.join("\n"));
  const operationsRoot = await read("app/audience/operations-root.tsx");
  const maintenanceRoot = await read("app/audience/maintenance-root.tsx");
  assert.match(shell, /visibleNavigationGroups\(navigation, access\.permissions\)/);
  assert.match(login, /allowRegistration/);
  assert.match(operationsRoot, /allowRegistration=\{false\}/);
  assert.match(maintenanceRoot, /allowRegistration=\{false\}/);
  assert.doesNotMatch(operations + maintenance, /AppLogin/);
  for (const path of ["app/api/auth/register/route.client.ts", "app/api/auth/forgot-password/route.client.ts"]) {
    const endpoint = await read(path);
    assert.match(endpoint, /currentRequestAudience\(request\) !== "client"/);
    assert.match(endpoint, /status: 404/);
  }
});

test("login routes do not start authenticated session trees or prefetch protected roots", async () => {
  const login = await read("packages/ui/src/app-login.tsx");
  const consoleCss = await read("app/riverton-console.css");
  const layout = await read("app/layout.tsx");
  assert.match(login, /<Link href="\/" prefetch=\{false\}>/);
  assert.match(consoleCss, /\.rc-auth\s*\{[^}]*font-family:\s*system-ui/s);
  assert.doesNotMatch(consoleCss, /\.rc-auth\s*\{[^}]*var\(--font-geist-sans\)/s);
  assert.equal((layout.match(/preload:\s*false/g) ?? []).length, 2);
  for (const [rootPath, applicationPath, applicationName] of [
    ["app/audience/client-portal-root.tsx", "apps/client/ui/client-portal.tsx", "ClientPortal"],
    ["app/audience/operations-root.tsx", "apps/operations/ui/operations-app.tsx", "OperationsApp"],
    ["app/audience/maintenance-root.tsx", "apps/maintenance/ui/maintenance-app.tsx", "MaintenanceApp"],
  ]) {
    const root = await read(rootPath);
    const application = await read(applicationPath);
    const loginBranch = root.indexOf('segments[0] === "login"');
    const authenticatedBranch = root.indexOf(`return <${applicationName}`);
    assert.ok(loginBranch >= 0 && authenticatedBranch > loginBranch, `${rootPath} must dispatch login before the authenticated client tree`);
    assert.match(root, /return <AppLogin/);
    assert.doesNotMatch(application, /AppLogin|segments\[0\] === "login"/);
    assert.match(application, /const session = useAppSession/);
  }
});

test("internal login retains TOTP enrollment and verification behind the rollout switch", async () => {
  const login = await read("packages/ui/src/app-login.tsx");
  assert.match(login, /mfaEnrollmentRequired/);
  assert.match(login, /\/api\/auth\/mfa\/enroll\/start/);
  assert.match(login, /\/api\/auth\/mfa\/enroll\/confirm/);
  assert.match(login, /\/api\/auth\/mfa\/verify/);
  assert.match(login, /recoveryCodes/);
  assert.match(login, /autoComplete="one-time-code"/);
  assert.match(login, /useSyncExternalStore/);
  assert.match(login, /emptyLocationSnapshot/);
  assert.doesNotMatch(login, /useState\(readStaffInviteFromUrl\)/);
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
  assert.match(shell, /matchMedia\("\(max-width: 900px\)"\)/);
  assert.match(shell, /inert=/);
  assert.match(shell, /document\.body\.style\.overflow/);
  assert.doesNotMatch(shell, /运营数据按权限展示|配置密钥不会在浏览器回显|兼容角色/);
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
  assert.match(sessionHook, /accessResponse\.status === 401[\s\S]*status: "anonymous"/);
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
  const routeContract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const navigation = await read("apps/client/ui/client-portal-shell.tsx");
  for (const route of ["dashboard", "membership", "credits", "paper", "trading-hall"]) {
    assert.match(routeContract, new RegExp(`CLIENT_ROUTES[\\s\\S]*["']${route}["']`));
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

test("authenticated Client navigation stays inside the customer trading product", async () => {
  const shell = await read("apps/client/ui/client-portal-shell.tsx");
  const login = await read("packages/ui/src/app-login.tsx");
  const landing = await read("apps/client/ui/client-public-landing.tsx");
  assert.doesNotMatch(shell, /ConsoleShell|@\/packages\/ui\/src\/console-shell/);
  assert.match(shell, /href: "\/dashboard"/);
  assert.match(shell, /交易大厅/);
  assert.match(shell, /模拟组合/);
  assert.doesNotMatch(shell, /href: "\/"/);
  assert.match(login, /audience === "client" \? "\/dashboard" : "\/"/);
  assert.match(landing, /\/login\?next=\$\{encodeURIComponent\("\/dashboard"\)\}/);
});

test("Client dashboard leads with portfolio and strategy state instead of compliance administration", async () => {
  const dashboard = await read("apps/client/ui/client-home-workspace.tsx");
  assert.match(dashboard, /组合总权益/);
  assert.match(dashboard, /三张官方策略/);
  assert.match(dashboard, /进入交易大厅/);
  assert.doesNotMatch(dashboard, /CONTROLLED BETA|PERMISSION-AWARE MODULES|Beta 执行边界|已授权模块/);
});

test("客户端外壳在渲染任何工作区之前强制会话与权限", async () => {
  // 原断言守的是 /workspace 的加载器（P4 已退役）。同一条约束现在由门户外壳
  // ClientChrome 与 client-portal 的逐路由权限判定承担，绊线跟着搬过来。
  const chrome = await read("apps/client/ui/client-chrome.tsx");
  const portal = await read("apps/client/ui/client-portal.tsx");
  assert.match(chrome, /AppSessionProvider audience="client"/);
  assert.match(chrome, /status === "anonymous"/);
  assert.match(chrome, /\/login\?next=/);
  assert.match(chrome, /ClientPortalShell/);
  assert.doesNotMatch(chrome, /\/api\/membership\/legal-consent|consentComplete|legalConsentGate/);
  assert.match(portal, /session\.status !== "authenticated"/);
  // 从 /workspace 迁过来的四个界面都必须自带权限判定，不能靠外壳兜底。
  for (const guarded of ["studio", "trading-hall"]) {
    assert.match(portal, new RegExp(`route === "${guarded}"[\\s\\S]{0,200}client\\.paper\\.view`));
  }
  assert.match(portal, /AccessDenied/);
});

test("client exposes standalone disclosures without blocking the trading workbench", async () => {
  const routeContract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const navigation = await read("apps/client/ui/client-portal-shell.tsx");
  const legal = await read("apps/client/ui/legal-consent-experience.tsx");
  assert.match(routeContract, /root === "legal"[\s\S]*segments\[1\] === "consent"/);
  assert.match(portal, /route === "legal"[\s\S]*segments\[1\] === "consent"[\s\S]*LegalConsentExperience/);
  assert.doesNotMatch(navigation, /label: "商业披露"/);
  assert.match(legal, /\/api\/membership\/legal-consent/);
  assert.match(legal, /商业披露与版本确认/);
  assert.match(legal, /确认会独立保存/);
  assert.match(legal, /acceptedDocumentVersionIds/);
  assert.match(legal, /idempotency-key/);
  assert.doesNotMatch(portal, /legalConsentGate|shouldCheckLegalConsent|\/legal\/consent\?next=/);
});

test("client workspaces bind to real wallet, Udun deposit orders, and notifications", async () => {
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");
  const notifications = await read("apps/client/ui/notification-workspace.tsx");
  assert.match(wallet, /\/api\/wallet\/balances/);
  assert.match(wallet, /\/api\/wallet\/ledger/);
  assert.match(deposits, /UDUN/);
  assert.match(deposits, /\/api\/wallet\/deposit-orders/);
  assert.match(deposits, /idempotency-key/);
  assert.match(notifications, /\/api\/notifications\/inbox/);
  assert.match(notifications, /ClientNotificationSettings/);
});

test("access center can publish approved draft roles with an audited reason", async () => {
  const center = await read("packages/ui/src/access-center.tsx");
  const publish = await read("app/api/access/roles/[id]/publish/route.internal.ts");
  assert.match(center, /kind: "publish"/);
  assert.match(center, /role\.status === "draft"/);
  assert.match(center, /InlineAuditReasonField/);
  assert.match(center, /角色配置原因/);
  assert.match(center, /模板配置原因/);
  assert.match(center, /角色分配原因/);
  assert.doesNotMatch(center, /setPending\(\{ kind: "(?:role|template|publish|assignment)"/);
  assert.match(center, /setPending\(\{ kind: "revoke"/);
  assert.match(center, /setPending\(\{ kind: "decision"/);
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
  const source = await read("app/api/maintenance/payment-providers/[id]/test/route.maintenance.ts");
  assert.match(source, /PAYMENT_PROVIDER_TESTS_ENABLED !== "true"/);
  assert.match(source, /503/);
  assert.match(source, /maintenanceReason/);
});

test("maintenance connectivity tests keep audited reasons without redundant configuration dialogs", async () => {
  for (const path of [
    "app/api/admin/agent-role-bindings/test/route.maintenance.ts",
    "app/api/admin/runtime-explanation-bindings/test/route.maintenance.ts",
    "app/api/maintenance/email/test/route.maintenance.ts",
  ]) {
    assert.match(await read(path), /maintenanceReason/);
  }
  const models = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.match(models, /kind: "test"/);
  assert.match(models, /InlineAuditReasonField/);
  const email = await read("apps/maintenance/ui/email-integration-workspace.tsx");
  assert.match(email, /InlineAuditReasonField/);
  assert.doesNotMatch(email, /ConfirmActionDialog/);
  const sources = await read("apps/maintenance/ui/source-integrations-workspace.tsx");
  assert.match(sources, /InlineAuditReasonField/);
  assert.doesNotMatch(sources, /ConfirmActionDialog/);
  const payment = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.match(payment, /DEPOSIT ONLY/);
  assert.match(payment, /InlineAuditReasonField/);
  assert.match(payment, /kind: "activate" \| "disable"/);
  assert.match(payment, /hasValidAuditReason\(statusReason\)/);
  assert.doesNotMatch(payment, /ConfirmActionDialog/);
  assert.match(payment, /idempotency-key/);
});

test("maintenance model workspaces separate read access from write controls", async () => {
  const source = await Promise.all([read("apps/maintenance/ui/maintenance-app.tsx"), read("apps/maintenance/ui/navigation.ts")]).then((parts) => parts.join("\n"));
  assert.match(source, /href: "\/models"[\s\S]*maint\.system_health\.view/);
  assert.match(source, /route === "models" \? \["maint\.system_health\.view"/);
  assert.match(source, /canManageProfiles/);
  assert.match(source, /canManageBindings/);
});

test("工作记录页面同时说明公共决策与个人准入，并按需懒加载", async () => {
  const routeContract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const navigation = await read("apps/client/ui/client-portal-shell.tsx");
  const workspace = await read("apps/client/ui/work-records-workspace.tsx");

  assert.match(routeContract, /CLIENT_ROUTES[\s\S]*"work-records"/);
  assert.match(navigation, /href: "\/work-records"/);
  assert.match(portal, /route === "work-records"/);
  assert.match(portal, /client\.paper\.view/);
  // 根 layout 被所有页面共享，Client 初始 JS 预算余量只有约 160 字节；
  // 新工作区必须按需加载，静态 import 会直接把它打进公开落地页的包。
  assert.match(portal, /const WorkRecordsWorkspace = dynamic\(\(\) => import\("\.\/work-records-workspace"\)/);

  // 客户不能把共享的七阶段叙述误解成「平台为我一个人跑了七次 Agent」，
  // 也不能误以为所有订阅者仓位相同（STRATEGY_WORK_RECORDS_SPEC §2）。
  assert.match(workspace, /公共/);
  assert.match(workspace, /你的组合准入/);
  assert.match(workspace, /只判断一次/);
});

test("工作记录不得把「无需准入」与「未记录」混为一谈", async () => {
  const workspace = await read("apps/client/ui/work-records-workspace.tsx");
  // 合并这两种状态会让「证据缺失」看起来像「产品规则如此」，违反 INV-6。
  // 只有纯 hold 且无客户周期才是 not_required，其余缺周期一律 not_recorded。
  assert.match(workspace, /not_required: "本轮无需准入"/);
  assert.match(workspace, /not_recorded: "未记录准入"/);
  assert.match(workspace, /not_recorded:[\s\S]*不表示无需准入，也不表示已经执行/);
  assert.match(workspace, /risk_rejected/);

  // 模拟成交不得被描述成真实成交，页面必须明示真实订单路由关闭。
  assert.match(workspace, /不是真实交易所成交/);
  assert.match(workspace, /realOrderRoutingEnabled/);

  // 分页游标是服务端编码的不透明位置，不得由浏览器构造或猜测。
  assert.match(workspace, /encodeURIComponent\(cursor\)/);
  assert.doesNotMatch(workspace, /offset=/);
});

test("Maintenance 导出页只做受控导出，不提供逐条客户详情", async () => {
  const routeContract = await read("app/riverton-route-contract.ts");
  const navigation = await read("apps/maintenance/ui/navigation.ts");
  const dispatcher = await read("apps/maintenance/ui/maintenance-app.tsx");
  const workspace = await read("apps/maintenance/ui/work-record-export-workspace.tsx");

  assert.match(routeContract, /MAINTENANCE_ROUTES[\s\S]*"work-records"/);
  assert.match(navigation, /href: "\/work-records", label: "工作记录导出"/);
  assert.match(navigation, /maint\.work_records\.export/);
  assert.match(dispatcher, /route === "work-records" \? \["maint\.work_records\.export"\]/);
  assert.match(dispatcher, /const WorkRecordExportWorkspace = dynamic\(/);

  // 导出是独立敏感权限，不能搭在既有 Maintenance 权限上顺带获得。
  assert.doesNotMatch(navigation, /href: "\/work-records"[^}]*maint\.ai_usage\.view/);

  // Maintenance 配置与控制流程一律页面内原因直接执行，不使用确认弹窗。
  assert.doesNotMatch(workspace, /ConfirmActionDialog|window\.confirm/);
  assert.match(workspace, /审计原因/);
  // 幂等键必须在成功后才轮换：结果不确定时重试复用同一个键，否则一次导出写两条审计。
  assert.match(workspace, /"Idempotency-Key": idempotencyKey/);
  assert.match(workspace, /setIdempotencyKey\(crypto\.randomUUID\(\)\);/);
});

test("导出页如实呈现截断与模拟边界，不声称结果完整", async () => {
  const workspace = await read("apps/maintenance/ui/work-record-export-workspace.tsx");
  // 命中上限必须显式告知不完整；把 truncated 显示成普通条数会让人把抽样当全量。
  assert.match(workspace, /result\.truncated/);
  assert.match(workspace, /不是该区间的完整记录/);
  assert.match(workspace, /realOrderRoutingEnabled/);
  assert.match(workspace, /Paper 模拟/);
  // 页面不得回显原始用户标识：只有单向伪名。
  assert.match(workspace, /customerPseudonym/);
  assert.doesNotMatch(workspace, /\bemail\b|\bphone\b|ownerUserId|userId/);
});
