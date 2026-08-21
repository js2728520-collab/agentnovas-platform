import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("membership experience uses commercial truth sources and contains no simulated payment flow", async () => {
  const entry = await read("app/membership-center.tsx");
  const experience = await read("apps/client/ui/membership-experience.tsx");
  const plansRoute = await read("app/api/membership/plans/route.ts");
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

test("legal consent records the current seven-document bundle without creating an order", async () => {
  const legal = await read("apps/client/ui/legal-consent-experience.tsx");
  assert.match(legal, /requiredLegalDocuments/);
  assert.match(legal, /contentMarkdown/);
  assert.match(legal, /contentSha256/);
  assert.match(legal, /\/api\/membership\/legal-consent/);
  assert.match(legal, /method:\s*"POST"/);
  assert.match(legal, /idempotency-key/);
  assert.match(legal, /acceptedDocumentVersionIds/);
  assert.match(legal, /parseLegalMarkdown/);
  assert.match(legal, /法务接口返回不完整/);
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

test("wallet is read-only and the deposit workspace is a closed Beta boundary", async () => {
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");
  assert.match(wallet, /只读/);
  assert.doesNotMatch(wallet, /创建充值订单/);
  assert.match(deposits, /Beta/);
  assert.match(deposits, /暂不开放/);
  assert.doesNotMatch(deposits, /fetch\(|deposit-orders|method:\s*["']POST["']/);
});

test("client notification settings expose unintegrated external channels without demo verification", async () => {
  const workspace = await read("apps/client/ui/notification-workspace.tsx");
  const settings = await read("apps/client/ui/client-notification-settings.tsx");
  const preferencesRoute = await read("app/api/notifications/preferences/route.ts");
  assert.match(workspace, /ClientNotificationSettings/);
  assert.match(settings, /not_integrated/);
  assert.match(settings, /\/api\/notifications\/preferences/);
  assert.doesNotMatch(settings, /verificationCode|演示验证码|\/api\/notifications\/channels/);
  assert.match(preferencesRoute, /allowedChannels = new Set\(\["in_app", "email"\]\)/);
  assert.match(preferencesRoute, /readResearchJson\(request, 4_096\)/);
  assert.match(preferencesRoute, /MANDATORY_NOTIFICATION/);
  assert.match(preferencesRoute, /onConflictDoUpdate/);
  assert.doesNotMatch(preferencesRoute, /select\(\)\.from\(notificationPreferences\)/);
});

test("trading experience reads official paper evidence and never presents client exchange writes", async () => {
  const entry = await read("app/trading-center.tsx");
  const experience = await read("apps/client/ui/trading-experience.tsx");
  const source = `${entry}\n${experience}`;
  assert.match(source, /\/api\/trading-hall\/paper\/portfolio/);
  assert.match(source, /\/api\/trading-hall\/paper\/trades/);
  assert.match(source, /\/api\/trading-hall/);
  assert.match(source, /未提供平台验证回执/);
  assert.doesNotMatch(source, /\/api\/exchange-accounts|\/api\/portfolio|\/api\/trading\/emergency-stop/);
  assert.doesNotMatch(source, /连接交易所|API Key/);
});

test("the client application no longer exposes the legacy operations page", async () => {
  const source = await read("app/client-app.tsx");
  const css = `${await read("app/globals.css")}\n${await read("app/globals-beta.css")}`;
  assert.doesNotMatch(source, /case\s+["']admin["']/);
  assert.doesNotMatch(source, /\|\s*["']admin["']/);
  assert.doesNotMatch(source, /AdminWithPolicy/);
  assert.match(source, /ClientNotificationSettings/);
  assert.match(source, /client-app-shell/);
  assert.match(source, /className="flow" tabIndex=\{0\}/);
  assert.match(css, /\.client-app-shell \.dash>aside\{[^}]*flex-direction:row!important/);
  assert.match(css, /\.client-app-shell \.landing \.hero:before\{[^}]*right:0!important/);
});

test("client raster assets stay under the 200 KiB budget and the hall uses an optimized source", async () => {
  const source = await read("app/client-app.tsx");
  const css = await read("app/globals.css");
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
