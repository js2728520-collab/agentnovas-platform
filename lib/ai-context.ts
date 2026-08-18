import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import {
  communityStrategies,
  platformStrategySubscriptions,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import type { AssistantContext } from "@/lib/ai-chat-protocol";
import { summarizeResearchCandles, type ResearchCandle } from "@/lib/ai-research";
import { fetchPublicMarketJson, publicMarketProviderName } from "@/lib/public-market-source";

const allowedMarketSymbols = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "TRX",
  "DOT", "LTC", "BCH", "TON", "SUI", "APT", "NEAR", "ARB", "OP", "UNI",
]);
const platformStrategyNames: Record<string, string> = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
};

function requestedSymbol(message: string) {
  const normalized = message.toUpperCase();
  for (const symbol of allowedMarketSymbols) {
    if (new RegExp(`(^|[^A-Z])${symbol}(?:\\s*[/_-]?\\s*USDT)?([^A-Z]|$)`).test(normalized)) return `${symbol}USDT`;
  }
  return null;
}

async function marketContext(message: string): Promise<AssistantContext["market"]> {
  const symbol = requestedSymbol(message);
  if (!symbol) return null;
  try {
    const { data, base } = await fetchPublicMarketJson<unknown[]>(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=120`,
      4_000,
    );
    const candles = data.flatMap((row): ResearchCandle[] => {
      if (!Array.isArray(row) || row.length < 7) return [];
      const values = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]].map(Number);
      if (!values.every(Number.isFinite)) return [];
      return [{
        openTime: values[0],
        open: values[1],
        high: values[2],
        low: values[3],
        close: values[4],
        volume: values[5],
        closeTime: values[6],
      }];
    });
    return summarizeResearchCandles(symbol, candles, publicMarketProviderName(base));
  } catch {
    // Preserve the lightweight ticker fallback when the K-line endpoint is unavailable.
  }
  try {
    const { data, base } = await fetchPublicMarketJson<{
      lastPrice: string;
      priceChangePercent: string;
      highPrice: string;
      lowPrice: string;
    }>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, 4_000);
    const values = [data.lastPrice, data.priceChangePercent, data.highPrice, data.lowPrice].map(Number);
    if (!values.every(Number.isFinite)) return null;
    return {
      symbol,
      price: values[0],
      change24hPct: values[1],
      high24h: values[2],
      low24h: values[3],
      source: publicMarketProviderName(base),
    };
  } catch {
    return null;
  }
}

export async function buildAssistantContext(userId: string, message: string): Promise<AssistantContext> {
  const db = getDb();
  const [tradeRows, communityFollowing, platformFollowing, market] = await Promise.all([
    db.select({ symbol: trades.symbol })
      .from(trades)
      .where(and(eq(trades.customerId, userId), isNull(trades.closedAt)))
      .limit(1_000),
    db.select({ name: communityStrategies.name })
      .from(strategySubscriptions)
      .innerJoin(communityStrategies, eq(communityStrategies.id, strategySubscriptions.strategyId))
      .where(and(eq(strategySubscriptions.customerId, userId), eq(strategySubscriptions.status, "active")))
      .limit(20),
    db.select({ strategyCode: platformStrategySubscriptions.strategyCode })
      .from(platformStrategySubscriptions)
      .where(and(eq(platformStrategySubscriptions.customerId, userId), eq(platformStrategySubscriptions.status, "active")))
      .limit(20),
    marketContext(message),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    market,
    portfolio: {
      openPositions: tradeRows.length,
      positionSymbols: [...new Set(tradeRows.map((row) => row.symbol))].slice(0, 20),
      followedStrategies: [
        ...communityFollowing.map((row) => row.name),
        ...platformFollowing.map((row) => platformStrategyNames[row.strategyCode] || row.strategyCode),
      ].slice(0, 20),
    },
  };
}
