import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { platformSettings } from "@/db/schema";

export const supportedPlatformLocales = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "es-ES", "ru-RU"] as const;
export type PlatformLocale = (typeof supportedPlatformLocales)[number];
export type PlatformSettingSection = "system" | "features" | "billing" | "integrations" | "security";

export type SystemSettings = {
  siteName: string;
  primaryDomain: string;
  supportEmail: string;
  telegramSupportUrl: string;
  copyrightOwner: string;
  defaultLocale: PlatformLocale;
  supportedLocales: PlatformLocale[];
  maintenanceBanner: string;
};

export type FeatureSettings = {
  marketCenter: boolean;
  newsCenter: boolean;
  agentAssistant: boolean;
  strategyMarketplace: boolean;
  strategyStudio: boolean;
  tradingCenter: boolean;
  membershipCenter: boolean;
  notificationCenter: boolean;
  inviteRegistration: boolean;
  autoTrading: boolean;
  releaseChannel: "stable" | "beta" | "maintenance";
  minimumClientVersion: string;
};

export type BillingSettings = {
  settlementCurrency: "USDT" | "USD";
  pointsPerUsdt: number;
  couponsEnabled: boolean;
  refundsEnabled: boolean;
  commissionSettlementDay: number;
};

export type IntegrationSettings = {
  primaryMarketSource: "COINBASE" | "BINANCE" | "OKX" | "BYBIT" | "BITGET" | "GATE.IO" | "KUCOIN" | "KRAKEN";
  newsRssUrls: string[];
  newsRefreshSeconds: number;
  marketRequestTimeoutMs: number;
};

export type SecuritySettings = {
  maxActiveSessions: number;
  passwordMinLength: number;
  requireEmailVerification: boolean;
  loginIpAudit: boolean;
  rateLimitEnabled: boolean;
  emergencyStop: boolean;
  adminIpAllowlist: string[];
  blockedIpList: string[];
};

export type AllPlatformSettings = {
  system: SystemSettings;
  features: FeatureSettings;
  billing: BillingSettings;
  integrations: IntegrationSettings;
  security: SecuritySettings;
};

export const defaultPlatformSettings: AllPlatformSettings = {
  system: {
    siteName: "Riverton Capital",
    primaryDomain: "www.tzxsea.com",
    supportEmail: "support@agentnovas.com",
    telegramSupportUrl: "",
    copyrightOwner: "Riverton Capital",
    defaultLocale: "zh-CN",
    supportedLocales: [...supportedPlatformLocales],
    maintenanceBanner: "",
  },
  features: {
    marketCenter: true,
    newsCenter: true,
    agentAssistant: true,
    strategyMarketplace: true,
    strategyStudio: true,
    tradingCenter: true,
    membershipCenter: true,
    notificationCenter: true,
    inviteRegistration: true,
    autoTrading: false,
    releaseChannel: "stable",
    minimumClientVersion: "1.0.0",
  },
  billing: {
    settlementCurrency: "USDT",
    pointsPerUsdt: 1,
    couponsEnabled: false,
    refundsEnabled: false,
    commissionSettlementDay: 5,
  },
  integrations: {
    primaryMarketSource: "BINANCE",
    newsRssUrls: ["https://www.coindesk.com/arc/outboundfeeds/rss/", "https://cointelegraph.com/rss"],
    newsRefreshSeconds: 60,
    marketRequestTimeoutMs: 6000,
  },
  security: {
    maxActiveSessions: 3,
    passwordMinLength: 10,
    requireEmailVerification: false,
    loginIpAudit: true,
    rateLimitEnabled: true,
    emergencyStop: false,
    adminIpAllowlist: [],
    blockedIpList: [],
  },
};

function textValue(value: unknown, fallback: string, maxLength: number) {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, maxLength) : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const result = Number(value);
  return Number.isFinite(result) ? Math.min(max, Math.max(min, result)) : fallback;
}

function stringList(value: unknown, maxItems = 100) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(rows.map((item) => String(item).trim()).filter(Boolean))].slice(0, maxItems);
}

export function replaceLegacyBrand(value: string) {
  return value.replace(/AgentNovas/gi, "Riverton Capital");
}

export function normalizePlatformSetting<S extends PlatformSettingSection>(section: S, value: unknown): AllPlatformSettings[S] {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (section === "system") {
    const fallback = defaultPlatformSettings.system;
    const locales = stringList(input.supportedLocales, supportedPlatformLocales.length).filter((locale): locale is PlatformLocale => (supportedPlatformLocales as readonly string[]).includes(locale));
    const defaultLocale = (supportedPlatformLocales as readonly string[]).includes(String(input.defaultLocale)) ? input.defaultLocale as PlatformLocale : fallback.defaultLocale;
    return {
      siteName: replaceLegacyBrand(textValue(input.siteName, fallback.siteName, 80)),
      primaryDomain: textValue(input.primaryDomain, fallback.primaryDomain, 160).replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      supportEmail: textValue(input.supportEmail, fallback.supportEmail, 160),
      telegramSupportUrl: (() => {
        const candidate = textValue(input.telegramSupportUrl, fallback.telegramSupportUrl, 240);
        try {
          const parsed = new URL(candidate);
          const host = parsed.hostname.toLowerCase();
          return parsed.protocol === "https:" && ["t.me", "telegram.me", "www.telegram.me", "web.telegram.org"].includes(host) ? candidate : fallback.telegramSupportUrl;
        } catch { return fallback.telegramSupportUrl; }
      })(),
      copyrightOwner: replaceLegacyBrand(textValue(input.copyrightOwner, fallback.copyrightOwner, 120)),
      defaultLocale,
      supportedLocales: locales.length ? locales : fallback.supportedLocales,
      maintenanceBanner: textValue(input.maintenanceBanner, "", 240),
    } as AllPlatformSettings[S];
  }
  if (section === "features") {
    const fallback = defaultPlatformSettings.features;
    const releaseChannel = ["stable", "beta", "maintenance"].includes(String(input.releaseChannel)) ? input.releaseChannel as FeatureSettings["releaseChannel"] : fallback.releaseChannel;
    return {
      marketCenter: booleanValue(input.marketCenter, fallback.marketCenter),
      newsCenter: booleanValue(input.newsCenter, fallback.newsCenter),
      agentAssistant: booleanValue(input.agentAssistant, fallback.agentAssistant),
      strategyMarketplace: booleanValue(input.strategyMarketplace, fallback.strategyMarketplace),
      strategyStudio: booleanValue(input.strategyStudio, fallback.strategyStudio),
      tradingCenter: booleanValue(input.tradingCenter, fallback.tradingCenter),
      membershipCenter: booleanValue(input.membershipCenter, fallback.membershipCenter),
      notificationCenter: booleanValue(input.notificationCenter, fallback.notificationCenter),
      inviteRegistration: booleanValue(input.inviteRegistration, fallback.inviteRegistration),
      autoTrading: booleanValue(input.autoTrading, fallback.autoTrading),
      releaseChannel,
      minimumClientVersion: textValue(input.minimumClientVersion, fallback.minimumClientVersion, 30),
    } as AllPlatformSettings[S];
  }
  if (section === "billing") {
    const fallback = defaultPlatformSettings.billing;
    return {
      settlementCurrency: input.settlementCurrency === "USD" ? "USD" : "USDT",
      pointsPerUsdt: numberValue(input.pointsPerUsdt, fallback.pointsPerUsdt, 0, 10000),
      couponsEnabled: booleanValue(input.couponsEnabled, fallback.couponsEnabled),
      refundsEnabled: booleanValue(input.refundsEnabled, fallback.refundsEnabled),
      commissionSettlementDay: Math.round(numberValue(input.commissionSettlementDay, fallback.commissionSettlementDay, 1, 28)),
    } as AllPlatformSettings[S];
  }
  if (section === "integrations") {
    const fallback = defaultPlatformSettings.integrations;
    const allowedSources = ["COINBASE", "BINANCE", "OKX", "BYBIT", "BITGET", "GATE.IO", "KUCOIN", "KRAKEN"];
    const primaryMarketSource = allowedSources.includes(String(input.primaryMarketSource).toUpperCase())
      ? String(input.primaryMarketSource).toUpperCase() as IntegrationSettings["primaryMarketSource"]
      : fallback.primaryMarketSource;
    const newsRssUrls = stringList(input.newsRssUrls, 12).filter((url) => {
      try { return new URL(url).protocol === "https:"; } catch { return false; }
    });
    return {
      primaryMarketSource,
      newsRssUrls: newsRssUrls.length ? newsRssUrls : fallback.newsRssUrls,
      newsRefreshSeconds: Math.round(numberValue(input.newsRefreshSeconds, fallback.newsRefreshSeconds, 15, 3600)),
      marketRequestTimeoutMs: Math.round(numberValue(input.marketRequestTimeoutMs, fallback.marketRequestTimeoutMs, 2000, 20000)),
    } as AllPlatformSettings[S];
  }
  const fallback = defaultPlatformSettings.security;
  return {
    maxActiveSessions: Math.round(numberValue(input.maxActiveSessions, fallback.maxActiveSessions, 1, 10)),
    passwordMinLength: Math.round(numberValue(input.passwordMinLength, fallback.passwordMinLength, 10, 64)),
    requireEmailVerification: booleanValue(input.requireEmailVerification, fallback.requireEmailVerification),
    loginIpAudit: booleanValue(input.loginIpAudit, fallback.loginIpAudit),
    rateLimitEnabled: booleanValue(input.rateLimitEnabled, fallback.rateLimitEnabled),
    emergencyStop: booleanValue(input.emergencyStop, fallback.emergencyStop),
    adminIpAllowlist: stringList(input.adminIpAllowlist),
    blockedIpList: stringList(input.blockedIpList),
  } as AllPlatformSettings[S];
}

export async function getAllPlatformSettings(): Promise<AllPlatformSettings> {
  const rows = await getDb().select().from(platformSettings);
  const bySection = new Map(rows.map((row) => [row.section, row]));
  const result = { ...defaultPlatformSettings } as AllPlatformSettings;
  for (const section of ["system", "features", "billing", "integrations", "security"] as PlatformSettingSection[]) {
    const row = bySection.get(section);
    if (!row) continue;
    try { result[section] = normalizePlatformSetting(section, JSON.parse(row.payloadJson)) as never; } catch { /* Keep safe defaults for malformed legacy rows. */ }
  }
  return result;
}

export async function getPlatformSetting<S extends PlatformSettingSection>(section: S): Promise<AllPlatformSettings[S]> {
  const row = (await getDb().select().from(platformSettings).where(eq(platformSettings.section, section)).limit(1))[0];
  if (!row) return defaultPlatformSettings[section];
  try { return normalizePlatformSetting(section, JSON.parse(row.payloadJson)); } catch { return defaultPlatformSettings[section]; }
}

export async function savePlatformSetting<S extends PlatformSettingSection>(section: S, value: unknown, updatedByUserId: string) {
  const normalized = normalizePlatformSetting(section, value);
  const now = new Date().toISOString();
  await getDb().insert(platformSettings).values({ id: section, section, payloadJson: JSON.stringify(normalized), updatedByUserId, updatedAt: now })
    .onConflictDoUpdate({ target: platformSettings.id, set: { payloadJson: JSON.stringify(normalized), updatedByUserId, updatedAt: now } });
  return normalized;
}
