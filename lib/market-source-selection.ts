import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { getPublicMarketSource, type MarketSourceKey } from "@/lib/market-sources";
import { getPlatformSetting } from "@/lib/platform-settings";
import { requireUser } from "@/lib/session";

export type MarketSourceSelectionMode = "manual" | "configured" | "default";

export type ConfiguredMarketSource = {
  exchange: MarketSourceKey;
  displayName: string;
  label: string;
  status: string;
  environment: string;
};

async function configuredMarketSources(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const rows = await getDb().select({ exchange: exchangeAccounts.exchange, label: exchangeAccounts.label, status: exchangeAccounts.status, environment: exchangeAccounts.environment, canRead: exchangeAccounts.canRead })
      .from(exchangeAccounts)
      .where(eq(exchangeAccounts.customerId, me.id))
      .orderBy(desc(exchangeAccounts.updatedAt));
    const seen = new Set<MarketSourceKey>();
    return rows.flatMap((row) => {
      const source = getPublicMarketSource(row.exchange);
      if (!source || !row.canRead || ["disconnected", "revoked"].includes(row.status) || seen.has(source.key)) return [];
      seen.add(source.key);
      return [{ exchange: source.key, displayName: source.displayName, label: row.label, status: row.status, environment: row.environment } satisfies ConfiguredMarketSource];
    });
  } catch {
    return [];
  }
}

export async function resolveMarketSource(request: Request, requestedExchange?: string | null) {
  const platformSettings = await getPlatformSetting("integrations").catch(() => null);
  const requestTimeoutMs = platformSettings?.marketRequestTimeoutMs || 6000;
  const manual = getPublicMarketSource(requestedExchange);
  if (manual) {
    return { source: manual, mode: "manual" as const, configured: await configuredMarketSources(request), requestTimeoutMs };
  }
  const configured = await configuredMarketSources(request);
  const configuredSource = configured[0] ? getPublicMarketSource(configured[0].exchange) : null;
  let platformDefault = getPublicMarketSource("BINANCE")!;
  if (platformSettings) platformDefault = getPublicMarketSource(platformSettings.primaryMarketSource) || platformDefault;
  const source = configuredSource || platformDefault;
  return { source, mode: configuredSource ? "configured" as const : "default" as const, configured, requestTimeoutMs };
}

export async function listMarketSourceSelection(request: Request) {
  return resolveMarketSource(request);
}

export type ResolvedMarketSource = Awaited<ReturnType<typeof resolveMarketSource>>;
