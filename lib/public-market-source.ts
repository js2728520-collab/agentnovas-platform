const OFFICIAL_PUBLIC_MARKET_BASES = [
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com",
  "https://api.binance.com",
];

function marketBases() {
  const configured = process.env.MARKET_DATA_BASE_URL?.trim().replace(/\/$/, "");
  return [...new Set([configured, ...OFFICIAL_PUBLIC_MARKET_BASES].filter((value): value is string => Boolean(value)))];
}

export async function fetchPublicMarketJson<T>(path: string, timeoutMs = 6_000) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const failures: string[] = [];
  for (const base of marketBases()) {
    try {
      const response = await fetch(`${base}${safePath}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        failures.push(`${new URL(base).hostname}: HTTP ${response.status}`);
        continue;
      }
      return { data: await response.json() as T, base };
    } catch (error) {
      failures.push(`${new URL(base).hostname}: ${error instanceof Error ? error.name : "request failed"}`);
    }
  }
  throw new Error(`公共行情源暂时不可用（${failures.join("；")}）`);
}

export function publicMarketProviderName(base: string) {
  return `Binance public market data · ${new URL(base).hostname}`;
}
