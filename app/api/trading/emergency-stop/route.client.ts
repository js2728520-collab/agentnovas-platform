import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  exchangeAccounts,
  platformStrategySubscriptions,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { closeOkxDemoTrade, type EmergencyCloseResult as CloseResult } from "@/lib/trading-emergency-close";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const body = await request.json().catch(() => ({})) as { closePositions?: boolean };
    const closePositions = body.closePositions === true;
    const db = getDb();
    const [platformSubscriptions, communitySubscriptions, openPositions] = await Promise.all([
      db.select().from(platformStrategySubscriptions).where(and(eq(platformStrategySubscriptions.customerId, me.id), eq(platformStrategySubscriptions.status, "active"))),
      db.select().from(strategySubscriptions).where(and(eq(strategySubscriptions.customerId, me.id), eq(strategySubscriptions.status, "active"))),
      db.select().from(trades).where(and(eq(trades.customerId, me.id), isNull(trades.closedAt))),
    ]);
    const now = new Date().toISOString();
    const statements = [
      ...platformSubscriptions.map((subscription) => db.update(platformStrategySubscriptions).set({ status: "paused", updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id))),
      ...communitySubscriptions.map((subscription) => db.update(strategySubscriptions).set({ status: "paused", updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id))),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: closePositions ? "trading.emergency_stop.close_requested" : "trading.emergency_stop.keep_positions",
        subjectType: "customer_trading_control",
        subjectId: me.id,
        afterJson: JSON.stringify({ closePositions, pausedPlatform: platformSubscriptions.length, pausedCommunity: communitySubscriptions.length, openPositions: openPositions.length, at: now }),
      }),
    ];
    if (statements.length) await db.batch(statements);

    const results: CloseResult[] = [];
    if (closePositions) {
      for (const position of openPositions) {
        const account = (await db.select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, position.exchangeAccountId), eq(exchangeAccounts.customerId, me.id))).limit(1))[0];
        if (!account) {
          results.push({ tradeId: position.id, symbol: position.symbol, status: "failed", message: "绑定账户不存在" });
        } else if (position.executionVenue === "okx_demo" && account.environment === "demo" && account.status === "active" && account.canTrade) {
          results.push(await closeOkxDemoTrade(position, account, now));
        } else {
          results.push({ tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "该仓位的实盘订单路由尚未接通，未标记为已平仓" });
        }
      }
    }

    const closed = results.filter((result) => result.status === "closed").length;
    const pending = results.filter((result) => result.status === "pending").length;
    const blocked = results.filter((result) => result.status === "unsupported" || result.status === "failed").length;
    const message = closePositions
      ? `已关停当前账户新开仓；${closed} 个仓位已平仓${pending ? `，${pending} 个等待成交` : ""}${blocked ? `，${blocked} 个仓位未能真实平仓` : ""}`
      : `已关停当前账户新开仓，保留 ${openPositions.length} 个当前仓位`;
    return Response.json({ closePositions, pausedStrategies: platformSubscriptions.length + communitySubscriptions.length, openPositions: openPositions.length, closed, pending, blocked, results, message });
  } catch (error) {
    return responseError(error);
  }
}
