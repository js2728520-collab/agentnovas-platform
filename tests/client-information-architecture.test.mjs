import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clientPrimaryNavigation,
  resolveAccountCenterTab,
  resolveClientSection,
  resolveSettingsTab,
  resolveStrategyTab,
  resolveTradingTab,
} from "../apps/client/ui/client-information-architecture.ts";
import {
  PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  themeBootstrapScript,
} from "../packages/ui/src/theme-script.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client primary navigation is limited to the five product centers", () => {
  assert.deepEqual(clientPrimaryNavigation.map(({ href, label }) => ({ href, label })), [
    { href: "/dashboard", label: "数据看板" },
    { href: "/trading", label: "交易中心" },
    { href: "/strategies", label: "策略中心" },
    { href: "/market", label: "行情" },
    { href: "/assistant", label: "AI 助手" },
  ]);
});

test("legacy Client routes resolve to their consolidated section and tab", () => {
  assert.equal(resolveClientSection("/paper/portfolio-1"), "trading");
  assert.equal(resolveClientSection("/work-records/round-1"), "trading");
  assert.equal(resolveClientSection("/backtests/strategy-1"), "strategies");
  assert.equal(resolveClientSection("/wallet/deposits"), "account-center");
  assert.equal(resolveClientSection("/account/security"), "settings");
  assert.equal(resolveTradingTab("invalid", "paper"), "portfolios");
  assert.equal(resolveTradingTab("invalid", "work-records"), "records");
  assert.equal(resolveStrategyTab("invalid", "backtests"), "backtests");
  assert.equal(resolveAccountCenterTab("invalid", "credits", []), "credits");
  assert.equal(resolveAccountCenterTab("invalid", "wallet", ["deposits"]), "deposit");
  assert.equal(resolveAccountCenterTab(null, "account-center", [], ["wallet"]), "wallet");
  assert.equal(resolveSettingsTab("invalid", "account"), "security");
  assert.equal(resolveSettingsTab("invalid", "account", ["profile"]), "profile");
  assert.equal(resolveSettingsTab("legal", "settings"), "profile");
});

test("Client route contract accepts consolidated hubs while preserving stable aliases", async () => {
  const contract = await read("app/riverton-route-contract.ts");
  for (const route of ["trading", "strategies", "account-center", "settings", "notifications", "membership", "work-records"]) {
    assert.match(contract, new RegExp(`CLIENT_ROUTES[\\s\\S]*["']${route}["']`));
  }
});

test("theme bootstrap restores a valid mode and palette before hydration", () => {
  const attributes = new Map();
  const storage = new Map([
    [THEME_STORAGE_KEY, "dark"],
    [PALETTE_STORAGE_KEY, "forest"],
  ]);
  vm.runInNewContext(themeBootstrapScript, {
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    document: { documentElement: {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
    } },
  });
  assert.equal(attributes.get("data-theme"), "dark");
  assert.equal(attributes.get("data-palette"), "forest");
});

test("theme bootstrap rejects invalid stored appearance values", () => {
  const attributes = new Map([["data-theme", "dark"], ["data-palette", "forest"]]);
  const storage = new Map([
    [THEME_STORAGE_KEY, "sepia"],
    [PALETTE_STORAGE_KEY, "rainbow"],
  ]);
  vm.runInNewContext(themeBootstrapScript, {
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    document: { documentElement: {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
    } },
  });
  assert.equal(attributes.has("data-theme"), false);
  assert.equal(attributes.has("data-palette"), false);
});

test("Client shell puts notifications and account actions in the top bar", async () => {
  const shell = await read("apps/client/ui/client-portal-shell.tsx");
  const notifications = await read("apps/client/ui/client-notifications.tsx");
  assert.match(shell, /ClientNotifications/);
  assert.match(notifications, /aria-label=\{t\("通知"\)\}/);
  assert.match(shell, /账户中心/);
  assert.match(shell, /帮助与支持/);
  assert.doesNotMatch(shell, /ThemeToggle/);
  assert.doesNotMatch(shell, /label: "通知中心"/);
  assert.doesNotMatch(shell, /客户工作台|客户端 · 模拟盘|面包屑/);
  assert.doesNotMatch(`${shell}\n${notifications}`, /通知抽屉|通知中心/);
  assert.match(shell, /key=\{pathname === "\/notifications" \? "legacy-open" : "topbar"\}/);
});

test("Client settings keep only customer-managed preferences", async () => {
  const portal = await read("apps/client/ui/client-portal.tsx");
  assert.match(portal, /个人资料/);
  assert.match(portal, /外观/);
  assert.match(portal, /安全/);
  assert.match(portal, /通知/);
  assert.doesNotMatch(portal, /协议与授权|settings\?tab=legal/);
  assert.match(portal, /route === "legal" && segments\[1\] === "consent"/);
});

test("AI strategy action opens the strategy research tab", async () => {
  const portal = await read("apps/client/ui/client-portal.tsx");
  assert.match(portal, /onOpenStrategies=\{\(\) => window\.location\.assign\("\/strategies\?tab=research"\)\}/);
  assert.doesNotMatch(portal, /onOpenStrategies=\{\(\) => window\.location\.assign\("\/trading\?tab=hall"\)\}/);
});

test("Client strategy center fails closed while its protected APIs are disabled", async () => {
  const portal = await read("apps/client/ui/client-portal.tsx");
  const unavailable = await read("apps/client/ui/strategy-center-unavailable.tsx");
  assert.match(portal, /StrategyCenterUnavailable/);
  assert.doesNotMatch(portal, /const StrategyStudio = dynamic/);
  assert.doesNotMatch(portal, /const BacktestWorkspace = dynamic/);
  assert.match(unavailable, /<h1>\{t\("策略中心"\)\}<\/h1>/);
  assert.match(unavailable, /暂不可用/);
  assert.doesNotMatch(unavailable, /fetch\(|<button|href=/);
});

test("Client appearance settings expose three palettes and three modes", async () => {
  const appearance = await read("packages/ui/src/app-preference-settings.tsx");
  const portal = await read("apps/client/ui/client-portal.tsx");
  for (const label of ["跟随系统", "浅色", "深色", "经典", "海湾", "松林", "恢复默认"]) {
    assert.match(appearance, new RegExp(label));
  }
  assert.match(portal, /<AppPreferenceSettings audience="client" \/>/);
  assert.doesNotMatch(portal, /AppearanceSettings/);
  const tokens = await read("app/design-tokens.css");
  for (const palette of ["harbor", "forest"]) {
    assert.match(tokens, new RegExp(`data-palette=["']${palette}["']`));
  }
});

test("membership cards use an opaque semantic surface for readable text", async () => {
  const styles = await read("apps/client/ui/membership-experience.module.css");
  assert.doesNotMatch(styles, /background:\s*var\(--rv-overlay\)/);
  assert.match(styles, /background:\s*var\(--rv-muted\)/);
});

test("Client session listing excludes every expired session boundary", async () => {
  const migration = await read("postgres/migrations/0088_client_session_listing_expiry.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION client_list_sessions/);
  assert.match(migration, /session\.expires_at::timestamptz>now_input/);
  assert.match(migration, /session\.idle_expires_at>now_input/);
  assert.match(migration, /session\.absolute_expires_at>now_input/);
});
