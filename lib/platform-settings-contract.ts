import { supportedPlatformLocales, type PlatformLocale } from "./platform-locale.ts";

export { supportedPlatformLocales, type PlatformLocale } from "./platform-locale.ts";

export type SystemSettings = {
  siteName: string;
  primaryDomain: string;
  serviceOperatorName: string;
  serviceRegion: string;
  supportEmail: string;
  telegramSupportUrl: string;
  copyrightOwner: string;
  defaultLocale: PlatformLocale;
  maintenanceBanner: string;
};

export type PublicPlatformSettings = { system: SystemSettings };

export const defaultSystemSettings: SystemSettings = {
  siteName: "Riverton Capital",
  primaryDomain: "riverton-capital.com",
  serviceOperatorName: "",
  serviceRegion: "",
  supportEmail: "",
  telegramSupportUrl: "",
  copyrightOwner: "Riverton Capital",
  defaultLocale: "en-US",
  maintenanceBanner: "",
};

const telegramHosts = new Set(["t.me", "telegram.me", "www.telegram.me", "web.telegram.org"]);

export function normalizeTelegramSupportUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !telegramHosts.has(url.hostname.toLowerCase())) return "";
    if (!url.pathname || url.pathname === "/") return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function boundedString(value: unknown, fallback: string, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : fallback;
}

export function normalizeSystemSettings(value: unknown): SystemSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const locale = supportedPlatformLocales.includes(input.defaultLocale as PlatformLocale)
    ? input.defaultLocale as PlatformLocale
    : defaultSystemSettings.defaultLocale;
  return {
    siteName: boundedString(input.siteName, defaultSystemSettings.siteName, 80) || defaultSystemSettings.siteName,
    primaryDomain: boundedString(input.primaryDomain, defaultSystemSettings.primaryDomain, 160) || defaultSystemSettings.primaryDomain,
    serviceOperatorName: boundedString(input.serviceOperatorName, defaultSystemSettings.serviceOperatorName, 160),
    serviceRegion: boundedString(input.serviceRegion, defaultSystemSettings.serviceRegion, 300),
    supportEmail: boundedString(input.supportEmail, defaultSystemSettings.supportEmail, 254).toLowerCase(),
    telegramSupportUrl: normalizeTelegramSupportUrl(input.telegramSupportUrl),
    copyrightOwner: boundedString(input.copyrightOwner, defaultSystemSettings.copyrightOwner, 80) || defaultSystemSettings.copyrightOwner,
    defaultLocale: locale,
    maintenanceBanner: boundedString(input.maintenanceBanner, defaultSystemSettings.maintenanceBanner, 500),
  };
}
