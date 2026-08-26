import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PLATFORM_LOCALE_STORAGE_KEY,
  resolvePlatformLocale,
  supportedPlatformLocales,
} from "../lib/platform-locale.ts";

test("uses one bounded seven-locale allowlist with English fallback", () => {
  assert.deepEqual(supportedPlatformLocales, [
    "en-US",
    "zh-CN",
    "zh-TW",
    "ru-RU",
    "es-ES",
    "ja-JP",
    "ko-KR",
  ]);
  assert.equal(PLATFORM_LOCALE_STORAGE_KEY, "riverton.platform-locale");
  assert.deepEqual(resolvePlatformLocale({ savedLocale: null, browserLanguages: [] }), {
    locale: "en-US",
    source: "fallback",
  });
});

test("a canonical saved preference wins over browser order", () => {
  assert.deepEqual(resolvePlatformLocale({
    savedLocale: "ja-JP",
    browserLanguages: ["zh-CN", "en-US"],
  }), { locale: "ja-JP", source: "saved" });

  assert.deepEqual(resolvePlatformLocale({
    savedLocale: "ja-jp",
    browserLanguages: ["es-MX"],
  }), { locale: "es-ES", source: "browser" });
});

test("browser locale matching handles region, script, case, and underscore aliases", () => {
  const fixtures = [
    ["EN_gb", "en-US"],
    ["es-MX", "es-ES"],
    ["ru", "ru-RU"],
    ["ja", "ja-JP"],
    ["ko-kr", "ko-KR"],
    ["zh-Hant", "zh-TW"],
    ["zh_HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hans", "zh-CN"],
    ["zh-SG", "zh-CN"],
  ];
  for (const [browserLocale, expected] of fixtures) {
    assert.equal(resolvePlatformLocale({ savedLocale: null, browserLanguages: [browserLocale] }).locale, expected);
  }
});

test("ignores malformed candidates and bounds browser-controlled work", () => {
  const beyondLimit = Array.from({ length: 16 }, () => "unsupported").concat("ja-JP");
  assert.deepEqual(resolvePlatformLocale({ savedLocale: "<script>", browserLanguages: beyondLimit }), {
    locale: "en-US",
    source: "fallback",
  });
  assert.deepEqual(resolvePlatformLocale({
    savedLocale: null,
    browserLanguages: ["x".repeat(36), "ko"],
  }), { locale: "ko-KR", source: "browser" });
  assert.deepEqual(resolvePlatformLocale({ savedLocale: null, browserLanguages: "en-US" }), {
    locale: "en-US",
    source: "fallback",
  });
});

test("does not mutate browser language input", () => {
  const browserLanguages = ["fr-FR", "zh-TW"];
  const snapshot = [...browserLanguages];
  resolvePlatformLocale({ savedLocale: null, browserLanguages });
  assert.deepEqual(browserLanguages, snapshot);
});

test("platform settings reuse the locale truth and default to English", async () => {
  const settings = await import("../lib/platform-settings-contract.ts");
  assert.equal(settings.defaultSystemSettings.defaultLocale, "en-US");
  assert.equal(settings.supportedPlatformLocales, supportedPlatformLocales);
});

test("public landing resolves saved and browser preferences without geolocation", async () => {
  const source = await readFile(new URL("../apps/client/ui/client-public-landing.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<Lang>\("en-US"\)/);
  assert.match(source, /resolvePlatformLocale/);
  assert.match(source, /localStorage\.getItem\(PLATFORM_LOCALE_STORAGE_KEY\)/);
  assert.match(source, /localStorage\.setItem\(PLATFORM_LOCALE_STORAGE_KEY, nextLanguage\)/);
  assert.match(source, /browserLanguages: navigator\.languages/);
  assert.match(source, /import\("\.\/client-public-landing-locales"\)/);
  assert.match(source, /requestId !== localeRequest\.current/);
  assert.doesNotMatch(source, />跳到主要内容<|aria-label="四阶段产品流程|<small>平台测试账户<|Riverton Capital 首页/);
  assert.doesNotMatch(source, /geolocation|geoip|ipapi|x-forwarded-for/i);
});
