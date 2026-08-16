import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  exchangeAccounts,
  platformDecisions,
  platformStrategySubscriptions,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { decryptExchangeCredential } from "@/lib/exchange-credentials";
import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder } from "@/lib/okx-demo-execution";
import { requireUser, responseError } from "@/lib/session";

type OpenTrade = typeof trades.$inferSelect;
type CloseResult = {
  tradeId: string;
  symbol: string;
  status: "closed" | "pending" | "unsupported" | "failed";
  message: string;
};

async function closeOkxDemoTrade(position: OpenTrade, account: typeof exchangeAccounts.$inferSelect, now: string): Promise<CloseResult> {
  if (position.side !== "buy") {
    return { tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "当前仅支持现货多仓的一键平仓" };
  }

  try {
    const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
    if (position.status === "closing" && position.closeExchangeOrderId) {
      const order = await getOkxDemoOrder({ credentials, symbol: position.symbol, orderId: position.closeExchangeOrderId });
      if (order.state === "filled" && order.filledQuantity > 0 && order.averagePrice > 0) {
        const exitValueUsdt = order.averagePrice * order.filledQuantity;
        const closingFee = okxFeeInUsdt(order);
        const gross = exitValueUsdt - position.entryValueUsdt;
        const realizedNetPnlUsdt = Number((gross - position.feesUsdt - position.fundingUsdt - closingFee).toFixed(8));
        const statements = [
          getDb().update(trades).set({ status: "closed", closedAt: now, exitValueUsdt, feesUsdt: position.feesUsdt + closingFee, realizedNetPnlUsdt, updatedAt: now }).where(eq(trades.id, position.id)),
          getDb().insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: account.customerId, action: "trading.emergency_stop.okx_demo_close.filled", subjectType: "trade", subjectId: position.id, afterJson: JSON.stringify({ order, realizedNetPnlUsdt }) }),
        ];
        if (position.decisionId) statements.push(getDb().update(platformDecisions).set({ status: "completed", updatedAt: now } ).where(eq(platformDecisions.id, position.decisionId)) as never);
        await getDb().batch(statements);
        return { tradeId: position.id, symbol: position.symbol, status: "closed", message: "OKX 验证环境平仓回执已确认" };
      }
      if (["canceled", "mmp_canceled", "rejected"].includes(order.state)) {
        await getDb().update(trades).set({ status: "filled", closeExchangeOrderId: null, updatedAt: now }).where(eq(trades.id, position.id));
        return { tradeId: position.id, symbol: position.symbol, status: "failed", message: "原平仓单未成交，仓位仍然存在" };
      }
      return { tradeId: position.id, symbol: position.symbol, status: "pending", message: "已有平仓单，等待交易所回执" };
    }

    const order = await placeOkxDemoMarketOrder({
      credentials,
      symbol: position.symbol,
      side: "sell",
      quantity: position.quantity,
      clientOrderId: `EST${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`,
    });
    if (order.state !== "filled" || !(order.averagePrice > 0) || !(order.filledQuantity > 0)) {
      await getDb().batch([
        getDb().update(trades).set({ status: "closing", closeExchangeOrderId: order.orderId, updatedAt: now }).where(eq(trades.id, position.id)),
        getDb().insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: account.customerId, action: "trading.emergency_stop.okx_demo_close.submitted", subjectType: "trade", subjectId: position.id, afterJson: JSON.stringify({ order }) }),
      ]);
      return { tradeId: position.id, symbol: position.symbol, status: "pending", message: "OKX 验证环境平仓单已提交，等待成交回执" };
    }
    const exitValueUsdt = order.averagePrice * order.filledQuantity;
    const closingFee = okxFeeInUsdt(order);
    const realizedNetPnlUsdt = Number((exitValueUsdt - position.entryValueUsdt - position.feesUsdt - position.fundingUsdt - closingFee).toFixed(8));
    const statements = [
      getDb().update(trades).set({ status: "closed", closedAt: now, closeExchangeOrderId: order.orderId, exitValueUsdt, feesUsdt: position.feesUsdt + closingFee, realizedNetPnlUsdt, updatedAt: now }).where(eq(trades.id, position.id)),
      getDb().insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: account.customerId, action: "trading.emergency_stop.okx_demo_close.filled", subjectType: "trade", subjectId: position.id, afterJson: JSON.stringify({ order, realizedNetPnlUsdt }) }),
    ];
    if (position.decisionId) statements.push(getDb().update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, position.decisionId)) as never);
    await getDb().batch(statements);
    return { tradeId: position.id, symbol: position.symbol, status: "closed", message: "OKX 验证环境已完成平仓" };
  } catch (error) {
    return { tradeId: position.id, symbol: position.symbol, status: "failed", message: error instanceof Error ? error.message : "平仓请求失败" };
  }
}

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
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
