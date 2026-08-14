import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  communityStrategies,
  exchangeAccounts,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";

type Trade = typeof trades.$inferSelect;

const platformStrategyNames: Record<string, string> = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
};

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function parseSymbols(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function tradeMetrics(rows: Trade[]) {
  const closed = rows
    .filter((row) => Boolean(row.closedAt))
    .sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  const open = rows.filter((row) => !row.closedAt);
  const realizedPnlUsdt = closed.reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0);
  const returnBasisUsdt = closed.reduce((sum, row) => sum + row.entryValueUsdt, 0);
  const unrealizedRows = open.filter((row) => row.exitValueUsdt > 0);
  const unrealizedPnlUsdt = unrealizedRows.reduce(
    (sum, row) => sum + row.exitValueUsdt - row.entryValueUsdt - row.feesUsdt - row.fundingUsdt,
    0,
  );
  const wins = closed.filter((row) => row.realizedNetPnlUsdt > 0).length;
  let equity = 0;
  let peak = 0;
  let maximumDropUsdt = 0;
  const equityCurve = closed.map((row) => {
    equity += row.realizedNetPnlUsdt;
    peak = Math.max(peak, equity);
    maximumDropUsdt = Math.max(maximumDropUsdt, peak - equity);
    return { at: row.closedAt, value: round(equity) };
  });

  return {
    realizedPnlUsdt: round(realizedPnlUsdt),
    unrealizedPnlUsdt: round(unrealizedPnlUsdt),
    unrealizedReady: open.length === 0 || unrealizedRows.length === open.length,
    returnPct: returnBasisUsdt ? round((realizedPnlUsdt / returnBasisUsdt) * 100) : 0,
    maxDrawdownPct: returnBasisUsdt ? round((maximumDropUsdt / returnBasisUsdt) * 100) : 0,
    maxDrawdownUsdt: round(maximumDropUsdt),
    winRatePct: closed.length ? round((wins / closed.length) * 100) : 0,
    openPositions: open.length,
    closedTrades: closed.length,
    totalTrades: rows.length,
    activePrincipalUsdt: round(open.reduce((sum, row) => sum + row.entryValueUsdt, 0)),
    feesUsdt: round(rows.reduce((sum, row) => sum + row.feesUsdt + row.fundingUsdt, 0)),
    equityCurve,
  };
}

export async function GET(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const db = getDb();
    const [accounts, allRows, following] = await Promise.all([
      db
        .select({
          id: exchangeAccounts.id,
          exchange: exchangeAccounts.exchange,
          label: exchangeAccounts.label,
          environment: exchangeAccounts.environment,
          status: exchangeAccounts.status,
        })
        .from(exchangeAccounts)
        .where(eq(exchangeAccounts.customerId, me.id)),
      db.select().from(trades).where(eq(trades.customerId, me.id)).orderBy(asc(trades.createdAt)).limit(2000),
      db
        .select({
          subscriptionId: strategySubscriptions.id,
          strategyId: communityStrategies.id,
          name: communityStrategies.name,
          riskLevel: communityStrategies.riskLevel,
          symbolsJson: communityStrategies.symbolsJson,
          version: communityStrategies.version,
          status: strategySubscriptions.status,
          startedAt: strategySubscriptions.startedAt,
        })
        .from(strategySubscriptions)
        .innerJoin(communityStrategies, eq(communityStrategies.id, strategySubscriptions.strategyId))
        .where(eq(strategySubscriptions.customerId, me.id)),
    ]);

    // 绩效只统计平台策略订单。客户完全独立发起的订单不会进入收益与回撤。
    const attributedRows = allRows.filter((row) => row.origin !== "customer_manual");
    const summary = tradeMetrics(attributedRows);
    const open = allRows.filter((row) => !row.closedAt);
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const closedRows = attributedRows.filter((row) => Boolean(row.closedAt));

    const communityPerformance = following.map((subscription) => {
      const rows = attributedRows.filter((row) => row.communityStrategyId === subscription.strategyId);
      return {
        ...subscription,
        id: subscription.strategyId,
        source: "community",
        symbols: parseSymbols(subscription.symbolsJson),
        ...tradeMetrics(rows),
      };
    });

    const knownCommunityIds = new Set(following.map((row) => row.strategyId));
    const platformCodes = Array.from(
      new Set(
        attributedRows
          .filter((row) => !row.communityStrategyId || !knownCommunityIds.has(row.communityStrategyId))
          .map((row) => row.strategyCode)
          .filter((code): code is string => Boolean(code)),
      ),
    );
    const platformPerformance = platformCodes.map((code) => {
      const rows = attributedRows.filter((row) => row.strategyCode === code && !row.communityStrategyId);
      return {
        id: code,
        name: platformStrategyNames[code] || code,
        riskLevel: code.includes("aggressive") ? "high" : code.includes("conservative") ? "low" : "medium",
        symbols: Array.from(new Set(rows.map((row) => row.symbol))),
        version: null,
        status: rows.some((row) => !row.closedAt) ? "active" : "paused",
        startedAt: rows[0]?.openedAt || rows[0]?.createdAt || null,
        source: "platform",
        ...tradeMetrics(rows),
      };
    });

    return Response.json({
      live: true,
      accounts,
      summary: {
        ...summary,
        todayPnlUsdt: round(
          closedRows.filter((row) => row.closedAt?.slice(0, 10) === today).reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0),
        ),
        monthPnlUsdt: round(
          closedRows.filter((row) => row.closedAt?.slice(0, 7) === month).reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0),
        ),
        hasPerformanceData: closedRows.length > 0,
      },
      strategyPerformance: [...communityPerformance, ...platformPerformance],
      positions: open.map((row) => ({
        id: row.id,
        exchangeAccountId: row.exchangeAccountId,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        entryValueUsdt: row.entryValueUsdt,
        status: row.status,
        openedAt: row.openedAt,
        origin: row.origin,
        decisionId: row.decisionId,
        strategyCode: row.strategyCode,
        communityStrategyId: row.communityStrategyId,
      })),
    });
  } catch (error) {
    return responseError(error);
  }
}
