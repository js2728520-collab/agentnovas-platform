import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("membership experience uses commercial truth sources and contains no simulated payment flow", async () => {
  const entry = await read("app/membership-center.tsx");
  const experience = await read("apps/client/ui/membership-experience.tsx");
  const plansRoute = await read("app/api/membership/plans/route.client.ts");
  const source = `${entry}\n${experience}`;

  for (const endpoint of [
    "/api/membership/plans",
    "/api/membership/me",
    "/api/membership/orders",
    "/api/credits/me",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));

  assert.match(source, /paymentInstructionsStatus/);
  assert.match(source, /creditError/);
  assert.match(source, /积分服务暂不可用/);
  assert.doesNotMatch(source, /<aside className=\{styles\.balance\}/);
  assert.match(source, /acceptedDocumentVersionIds/);
  assert.match(source, /idempotency-key/);
  assert.doesNotMatch(experience, /<main\b/);
  assert.match(plansRoute, /ORDER BY commercial_plan_versions\.price_amount/);
  assert.doesNotMatch(source, /二维码|倒计时|监听中|充值积分|积分充值|TRC20|0x[a-fA-F0-9]{8}/);
});

test("membership experience constrains long legal content at narrow widths", async () => {
  const styles = await read("apps/client/ui/membership-experience.module.css");
  assert.match(styles, /\.root\{[^}]*min-width:0/);
  assert.match(styles, /\.legalItem[^}]*min-width:0/);
  assert.match(styles, /\.legalItem[^}]*overflow-wrap:anywhere/);
});

test("commercial disclosure consent records the current seven-document bundle without creating an order", async () => {
  const legal = await read("apps/client/ui/legal-consent-experience.tsx");
  assert.match(legal, /requiredLegalDocuments/);
  assert.match(legal, /contentMarkdown/);
  assert.match(legal, /contentSha256/);
  assert.match(legal, /\/api\/membership\/legal-consent/);
  assert.match(legal, /method:\s*"POST"/);
  assert.match(legal, /idempotency-key/);
  assert.match(legal, /acceptedDocumentVersionIds/);
  assert.match(legal, /parseLegalMarkdown/);
  assert.match(legal, /商业披露接口返回不完整/);
  assert.doesNotMatch(legal, /\/api\/membership\/orders|planCode|付款成功|会员已激活/);
});

test("client home uses permission-gated live summaries instead of static KPI", async () => {
  const home = await read("apps/client/ui/client-home-workspace.tsx");
  for (const endpoint of [
    "/api/membership/me",
    "/api/membership/orders?limit=1",
    "/api/credits/me",
    "/api/trading-hall/paper/portfolio",
  ]) assert.ok(home.includes(endpoint), `missing live summary endpoint: ${endpoint}`);
  assert.match(home, /hasAnyPermission/);
  assert.match(home, /useApiData/);
  assert.match(home, /deriveClientHomeTask/);
  assert.doesNotMatch(home, /rc-kpi-grid|单卡模拟本金|<strong>10,000<\/strong>|<strong>3<\/strong>/);
});

test("wallet remains read-only while deposits use the server-side Udun order boundary", async () => {
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");
  assert.match(wallet, /只读/);
  assert.doesNotMatch(wallet, /创建充值订单/);
  assert.match(deposits, /UDUN/);
  assert.match(deposits, /\/api\/wallet\/deposit-orders/);
  assert.match(deposits, /method:\s*"POST"/);
  assert.match(deposits, /idempotency-key/);
  assert.doesNotMatch(deposits, /QRCode|fakeAddress|0x[a-fA-F0-9]{20,}|T[A-Za-z0-9]{30,}/);
});

test("client notification settings expose unintegrated external channels without demo verification", async () => {
  const workspace = await read("apps/client/ui/notification-workspace.tsx");
  const settings = await read("apps/client/ui/client-notification-settings.tsx");
  const preferencesRoute = await read("app/api/notifications/preferences/route.client.ts");
  const preferencesPolicy = await read("lib/notification-preferences.ts");
  assert.match(workspace, /ClientNotificationSettings/);
  assert.match(settings, /not_integrated/);
  assert.match(settings, /\/api\/notifications\/preferences/);
  assert.doesNotMatch(settings, /verificationCode|演示验证码|\/api\/notifications\/channels/);
  assert.match(preferencesRoute, /normalizeNotificationPreferenceBatch/);
  assert.match(preferencesPolicy, /new Set\(\["in_app", "email"\]\)/);
  assert.match(preferencesRoute, /readResearchJson\(request, 4_096\)/);
  assert.match(preferencesPolicy, /MANDATORY_NOTIFICATION/);
  assert.match(preferencesRoute, /onConflictDoUpdate/);
  assert.doesNotMatch(preferencesRoute, /select\(\)\.from\(notificationPreferences\)/);
  await assert.rejects(
    read("app/notification-settings-panel.tsx"),
    (error) => error?.code === "ENOENT",
    "the retired notification panel must not remain as a second UI path with demo verification",
  );
});

test("trading experience reads official paper evidence and never presents client exchange writes", async () => {
  const entry = await read("app/trading-center.tsx");
  const experience = await read("apps/client/ui/trading-experience.tsx");
  const source = `${entry}\n${experience}`;
  assert.match(source, /\/api\/trading-hall\/paper\/portfolio/);
  assert.match(source, /\/api\/trading-hall\/paper\/trades/);
  assert.match(source, /\/api\/trading-hall/);
  assert.match(source, /\/api\/trading-hall\/paper\/platform-demo-summary/);
  assert.match(source, /脱敏的平台测试账户摘要/);
  assert.match(source, /不会改变客户 Paper 余额、成交或绩效账单/);
  assert.doesNotMatch(source, /\/api\/exchange-accounts|\/api\/portfolio|\/api\/trading\/emergency-stop/);
  assert.doesNotMatch(source, /连接交易所|API Key/);
});

// 已删除两条测试（P4）：
//
// 「the client application no longer exposes the legacy operations page」断言遗留
// SPA 内部没有 admin 分支。SPA 已退役，而这条约束现在由 P2 的构建隔离从结构上保证：
// 运营路由根本不在 client 构建里（架构边界规则「API 路由后缀与 audience 一致」，
// 以及 §28 记录的 404 矩阵）。文本断言已被更强的机制取代。
//
// 「the isolated strategy workspace opens live records instead of the legacy static
// landing」断言的是 SPA 的内部字符串路由（typeof window === "undefined" 时返回
// "hall"）。四个界面已各自成为真实路由，内部路由不复存在。

test("the trading hall presents server strategy state without simulated live activity", async () => {
  const workspace = await read("apps/client/ui/decision-hall.tsx");
  const moduleCss = await read("apps/client/ui/decision-hall.module.css");
  assert.match(workspace, /tradingHallStrategyPresentation/);
  assert.match(workspace, /tradingHallEnvironmentLabel/);
  assert.match(workspace, /角色位置仅为界面示意，不代表智能体正在运行/);
  assert.match(workspace, /三套AI策略服务端状态/);
  assert.doesNotMatch(workspace, /影子运行/);
  assert.doesNotMatch(workspace, /三套AI策略实时监控/);
  assert.doesNotMatch(workspace, /<small>运行策略<\/small>/);
  assert.doesNotMatch(workspace, /Math\.random/);
  assert.doesNotMatch(workspace, /action-\$\{agentActions/);
  assert.doesNotMatch(workspace, /\[\.\.\.rows, \.\.\.rows, \.\.\.rows\]/);
  // 原断言检查遗留样式表用 animation:none!important 压掉「看起来像实时活动」的
  // 效果，还要一个「暂停轮播」按钮。样式模块化后这些元素**根本没有动画**，
  // 约束由构造保证，断言改成更强的形式：模块里不得出现动画。
  assert.doesNotMatch(moduleCss, /animation\s*:/);
  assert.doesNotMatch(moduleCss, /@keyframes/);
  assert.doesNotMatch(workspace, /轮播/);
  // 另两条原断言（跑马灯的 focus-within 暂停、prefers-reduced-motion 降级）
  // 随跑马灯一起失去意义：没有动画就没有需要降级或暂停的东西。
});

test("client raster assets stay under the 200 KiB budget and the hall uses an optimized source", async () => {
  const source = await read("apps/client/ui/decision-hall.tsx");
  const css = await read("app/globals-beta.css");
  assert.match(source, /from "next\/image"/);
  assert.match(source, /\/trading-hall\.webp/);
  assert.doesNotMatch(`${source}\n${css}`, /trading-hall-base\.png|trading-hall-operator-sprite\.png|agentnovas-logo\.png|agentnovas-mark\.png|trading-hall\.png/);
  const publicRoot = new URL("../public/", import.meta.url);
  const rasterNames = (await readdir(publicRoot)).filter((name) => /\.(?:png|webp|avif|jpe?g)$/i.test(name));
  for (const name of rasterNames) {
    const size = (await stat(new URL(name, publicRoot))).size;
    assert.ok(size <= 200 * 1024, `${name} exceeds 200 KiB: ${size}`);
  }
});
