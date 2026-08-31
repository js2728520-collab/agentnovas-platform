import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  defaultUserAppPreference,
  localeOptionsForAudience,
  normalizeUserAppPreferencePatch,
} from "../lib/user-app-preference.ts";
import {
  appPreferenceBootstrapScript,
  PALETTE_STORAGE_KEY,
  PLATFORM_LOCALE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "../packages/ui/src/theme-script.ts";
import { requestInitialAppLocale } from "../lib/app-locale.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("application preferences use audience-specific locale allowlists and defaults", () => {
  assert.deepEqual(localeOptionsForAudience("client"), [
    "en-US", "zh-CN", "zh-TW", "ru-RU", "es-ES", "ja-JP", "ko-KR",
  ]);
  assert.deepEqual(localeOptionsForAudience("operations"), ["zh-CN", "en-US"]);
  assert.deepEqual(localeOptionsForAudience("maintenance"), ["zh-CN", "en-US"]);
  assert.deepEqual(defaultUserAppPreference("client", "ja-JP"), {
    locale: "ja-JP", themeMode: "system", themePalette: "classic",
  });
  assert.deepEqual(defaultUserAppPreference("client", "legacy-custom"), {
    locale: "en-US", themeMode: "system", themePalette: "classic",
  });
  assert.deepEqual(defaultUserAppPreference("operations", "ja-JP"), {
    locale: "zh-CN", themeMode: "system", themePalette: "classic",
  });
});

test("preference PATCH is partial, strict, and cannot accept an audience", () => {
  assert.deepEqual(normalizeUserAppPreferencePatch("client", { themeMode: "dark" }), { themeMode: "dark" });
  assert.deepEqual(normalizeUserAppPreferencePatch("maintenance", { locale: "en-US", themePalette: "forest" }), {
    locale: "en-US", themePalette: "forest",
  });
  assert.throws(() => normalizeUserAppPreferencePatch("operations", { locale: "ja-JP" }), /PREFERENCE_LOCALE_INVALID/);
  assert.throws(() => normalizeUserAppPreferencePatch("client", { themeMode: "sepia" }), /PREFERENCE_THEME_MODE_INVALID/);
  assert.throws(() => normalizeUserAppPreferencePatch("client", { themePalette: "rainbow" }), /PREFERENCE_THEME_PALETTE_INVALID/);
  assert.throws(() => normalizeUserAppPreferencePatch("client", { appAudience: "maintenance" }), /PREFERENCE_FIELD_INVALID/);
  assert.throws(() => normalizeUserAppPreferencePatch("client", {}), /PREFERENCE_PATCH_EMPTY/);
});

test("shared preference route is session-bound for all three audiences", async () => {
  const route = await read("app/api/account/preferences/route.shared.ts");
  const policy = await read("scripts/generate-api-route-inventory.mjs");
  assert.match(route, /requireCurrentSession/);
  assert.match(route, /current\.session\.appAudience/);
  assert.match(route, /current\.session\.tokenHash/);
  assert.doesNotMatch(route, /input\.(?:audience|appAudience)/);
  assert.match(policy, /route === "\/api\/account\/preferences"/);
});

test("preference endpoint and audience-specific locale bounds are documented in the current API contracts", async () => {
  const [catalog, openapi] = await Promise.all([
    read("docs/api/API_CATALOG.md"),
    read("docs/api/openapi-controlled-beta.yaml"),
  ]);
  assert.match(catalog, /`\/api\/account\/preferences` \| GET, PATCH \| C\/O\/M/);
  assert.match(catalog, /audience 从当前会话推导/);
  assert.match(openapi, /^ {2}\/api\/account\/preferences:/m);
  assert.match(openapi, /UserAppPreferencePatch:/);
  assert.match(openapi, /enum: \[system, light, dark\]/);
  assert.match(openapi, /enum: \[classic, harbor, forest\]/);
  assert.match(openapi, /Operations 与 Maintenance 只允许 zh-CN、en-US/);
});

test("three application settings use one shared preference workspace and no topbar theme toggle", async () => {
  const client = await read("apps/client/ui/client-portal.tsx");
  const operations = await read("apps/operations/ui/operations-app.tsx");
  const maintenance = await read("apps/maintenance/ui/maintenance-app.tsx");
  const internal = await read("packages/ui/src/internal-settings-workspace.tsx");
  const preferenceSettings = await read("packages/ui/src/app-preference-settings.tsx");
  const shell = await read("packages/ui/src/console-shell.tsx");
  assert.match(client, /AppPreferenceSettings/);
  for (const source of [operations, maintenance]) assert.match(source, /InternalSettingsWorkspace/);
  assert.match(internal, /AppPreferenceSettings/);
  assert.match(preferenceSettings, /editablePreference\(body\.preference/);
  assert.match(preferenceSettings, /body: JSON\.stringify\(\{\s*locale: draft\.locale,\s*themeMode: draft\.themeMode,\s*themePalette: draft\.themePalette,?\s*\}\)/);
  assert.doesNotMatch(preferenceSettings, /body: JSON\.stringify\(draft\)/);
  assert.doesNotMatch(shell, /ThemeToggle/);
  assert.match(shell, /href="\/settings"/);
});

test("authenticated first paint overrides stale local values with the audience-bound server preference", () => {
  const attributes = new Map();
  const storage = new Map([
    [THEME_STORAGE_KEY, "light"],
    [PALETTE_STORAGE_KEY, "classic"],
    [PLATFORM_LOCALE_STORAGE_KEY, "zh-CN"],
  ]);
  const root = {
    lang: "zh-CN",
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  vm.runInNewContext(appPreferenceBootstrapScript({
    audience: "client",
    preference: { locale: "ja-JP", themeMode: "dark", themePalette: "forest" },
  }), {
    document: { documentElement: root },
    navigator: { languages: ["en-US"] },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  assert.equal(root.lang, "ja-JP");
  assert.equal(attributes.get("data-theme"), "dark");
  assert.equal(attributes.get("data-palette"), "forest");
  assert.equal(storage.get(PLATFORM_LOCALE_STORAGE_KEY), "ja-JP");
});

test("anonymous locale fallback differs between Client and internal applications", () => {
  function execute(audience, savedLocale, browserLanguages) {
    const root = { lang: "", setAttribute() {}, removeAttribute() {} };
    vm.runInNewContext(appPreferenceBootstrapScript({ audience }), {
      document: { documentElement: root },
      navigator: { languages: browserLanguages },
      localStorage: {
        getItem: (key) => key === PLATFORM_LOCALE_STORAGE_KEY ? savedLocale : null,
        setItem() {},
      },
    });
    return root.lang;
  }
  assert.equal(execute("client", "invalid", ["ja-JP"]), "ja-JP");
  assert.equal(execute("client", null, ["fr-FR"]), "en-US");
  assert.equal(execute("operations", "ja-JP", ["en-US"]), "zh-CN");
  assert.equal(execute("maintenance", "en-US", ["zh-CN"]), "en-US");
});

test("anonymous server rendering honors the app cookie, then the supported Client browser language", () => {
  assert.equal(requestInitialAppLocale(new Headers({ cookie: "rv_locale_client=ja-JP" }), "client"), "ja-JP");
  assert.equal(requestInitialAppLocale(new Headers({ "accept-language": "fr-FR,es-ES;q=0.8" }), "client"), "es-ES");
  assert.equal(requestInitialAppLocale(new Headers({ "accept-language": "ja-JP" }), "operations"), "zh-CN");
  assert.equal(requestInitialAppLocale(new Headers({ cookie: "rv_locale_maintenance=en-US" }), "maintenance"), "en-US");
  assert.equal(requestInitialAppLocale(new Headers({ cookie: "rv_locale_operations=ja-JP" }), "operations"), "zh-CN");
});

test("the server-resolved locale is provided to every application workspace", async () => {
  const layout = await read("app/layout.tsx");
  const currentFrame = await read("app/audience/current-frame.tsx");
  const context = await read("packages/ui/src/app-locale-context.tsx");
  const clientShell = await read("apps/client/ui/client-portal-shell.tsx");
  const consoleShell = await read("packages/ui/src/console-shell.tsx");
  const hubTabs = await read("packages/ui/src/console-hub-tabs.tsx");

  assert.doesNotMatch(layout, /app-locale-context/);
  assert.match(layout, /initialLocale=\{initialLocale\}/);
  assert.match(currentFrame, /AppLocaleProvider/);
  assert.match(currentFrame, /initialLocale=\{initialLocale\}/);
  assert.match(context, /createContext/);
  assert.match(context, /useAppLocale/);
  assert.match(clientShell, /useAppLocale/);
  assert.match(consoleShell, /useAppLocale/);
  assert.match(hubTabs, /useAppLocale/);
});

test("audience builds defer the locale catalog while preserving non-Chinese locales on demand", async () => {
  const [nextConfig, runtimeContext] = await Promise.all([
    read("next.config.ts"),
    read("packages/ui/src/app-locale-context-runtime.tsx"),
  ]);

  assert.match(nextConfig, /const audienceLocaleEntry = appAudience/);
  assert.match(nextConfig, /"@\/packages\/ui\/src\/app-locale-context": audienceLocaleEntry/);
  assert.doesNotMatch(runtimeContext, /client-business-translations\.generated/);
  assert.match(runtimeContext, /locale === "zh-CN"/);
  assert.match(runtimeContext, /import\("\.\/app-locale-context"\)/);
  assert.match(runtimeContext, /module\.localizeAppText/);
  for (const path of [
    "packages/ui/src/console-shell.tsx",
    "packages/ui/src/console-hub-tabs.tsx",
    "packages/ui/src/page-state.tsx",
    "packages/ui/src/internal-settings-workspace.tsx",
  ]) {
    assert.match(await read(path), /@\/packages\/ui\/src\/app-locale-context/);
  }
});

test("the public English login uses a compact catalog before loading workspace translations", async () => {
  const { localizeLoginText, loginEnglish } = await import("../packages/ui/src/app-login-locale.ts");
  const [runtimeContext, fullCatalog, loginSource] = await Promise.all([
    read("packages/ui/src/app-locale-context-runtime.tsx"),
    read("packages/ui/src/app-locale-context.tsx"),
    read("packages/ui/src/app-login.tsx"),
  ]);

  assert.equal(localizeLoginText("安全登录", "en-US"), "Secure sign in");
  assert.equal(
    localizeLoginText("AI 策略研发、回测、模拟盘和会员资产中心。", "en-US"),
    "AI strategy research, backtesting, paper trading, and membership assets.",
  );
  assert.equal(localizeLoginText("安全登录", "zh-CN"), "安全登录");
  assert.equal(localizeLoginText("Riverton Capital", "en-US"), "Riverton Capital");
  for (const [key, value] of Object.entries(loginEnglish)) {
    assert.ok(fullCatalog.includes(`${JSON.stringify(key)}: ${JSON.stringify(value)}`));
  }
  const missingLoginKeys = [...loginSource.matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)]
    .map((match) => match[1])
    .filter((key) => loginEnglish[key] === undefined);
  assert.deepEqual(missingLoginKeys, []);
  assert.match(runtimeContext, /usePathname/);
  assert.match(runtimeContext, /pathname === "\/login"/);
  assert.match(runtimeContext, /localizeLoginText/);
});
