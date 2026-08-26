export const supportedPlatformLocales = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ru-RU",
  "es-ES",
  "ja-JP",
  "ko-KR",
] as const;

export type PlatformLocale = typeof supportedPlatformLocales[number];
export type PlatformLocaleSource = "saved" | "browser" | "fallback";

export const PLATFORM_LOCALE_STORAGE_KEY = "riverton.platform-locale";

const supportedLocaleSet = new Set<string>(supportedPlatformLocales);
const canonicalByLowerCase = new Map(supportedPlatformLocales.map((locale) => [locale.toLowerCase(), locale]));
const MAX_BROWSER_LANGUAGES = 16;
const MAX_LOCALE_LENGTH = 35;

function canonicalSavedLocale(input: unknown): PlatformLocale | null {
  return typeof input === "string" && supportedLocaleSet.has(input)
    ? input as PlatformLocale
    : null;
}

function canonicalBrowserLocale(input: unknown): PlatformLocale | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_LOCALE_LENGTH) return null;
  const normalized = input.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) return null;
  const exact = canonicalByLowerCase.get(normalized);
  if (exact) return exact;
  const parts = normalized.split("-");
  const language = parts[0];
  if (language === "zh") {
    return parts.some((part) => ["hant", "tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
  }
  if (language === "en") return "en-US";
  if (language === "ru") return "ru-RU";
  if (language === "es") return "es-ES";
  if (language === "ja") return "ja-JP";
  if (language === "ko") return "ko-KR";
  return null;
}

export function resolvePlatformLocale(input: {
  savedLocale: unknown;
  browserLanguages: unknown;
}): { locale: PlatformLocale; source: PlatformLocaleSource } {
  const saved = canonicalSavedLocale(input.savedLocale);
  if (saved) return { locale: saved, source: "saved" };
  if (Array.isArray(input.browserLanguages)) {
    for (const candidate of input.browserLanguages.slice(0, MAX_BROWSER_LANGUAGES)) {
      const locale = canonicalBrowserLocale(candidate);
      if (locale) return { locale, source: "browser" };
    }
  }
  return { locale: "en-US", source: "fallback" };
}
