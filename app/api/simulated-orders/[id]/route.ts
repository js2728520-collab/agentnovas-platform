import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, communityStrategies, platformDecisions, trades } from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";
import { getSpotPrice } from "@/lib/market-data";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const body = await request.json() as { action?: "close" | "cancel" };
    const db = getDb();
    const row = (await db.select().from(trades).where(and(eq(trades.id, id), eq(trades.customerId, me.id), isNull(trades.closedAt))).limit(1))[0];
    if (!row) return Response.json({ error: "未找到可操作的模拟持仓" }, { status: 404 });
    const strategy = row.communityStrategyId
      ? (await db.select({ id: communityStrategies.id }).from(communityStrategies).where(and(eq(communityStrategies.id, row.communityStrategyId), eq(communityStrategies.authorUserId, me.id))).limit(1))[0]
      : undefined;
    if (!strategy) return Response.json({ error: "普通模拟持仓已关闭；这里只能管理自己策略的测试仓位" }, { status: 403 });
    if (!body.action) return Response.json({ error: "缺少操作类型" }, { status: 400 });
    const now = new Date().toISOString();
    if (body.action === "cancel") {
      await db.batch([
        db.update(trades).set({ status: "cancelled", closedAt: now, updatedAt: now }).where(eq(trades.id, id)),
        db.update(platformDecisions).set({ status: "cancelled", updatedAt: now }).where(eq(platformDecisions.id, row.decisionId || "")),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "simulated_order.cancelled", subjectType: "trade", subjectId: id, afterJson: JSON.stringify({ orderId: row.exchangeOrderId, reason: "customer_or_risk_cancel" }) }),
      ]);
      return Response.json({ status: "cancelled", message: "模拟订单已撤销" });
    }
    let quote: Awaited<ReturnType<typeof getSpotPrice>>;
    try {
      quote = await getSpotPrice(row.symbol);
    } catch {
      return Response.json({ error: "无法取得可信实时价格，暂不能模拟平仓" }, { status: 503 });
    }
    const exitValue = quote.price * row.quantity;
    const closingFee = Number((exitValue * 0.001).toFixed(8));
    const grossPnl = row.side === "sell" ? row.entryValueUsdt - exitValue : exitValue - row.entryValueUsdt;
    const pnl = Number((grossPnl - row.feesUsdt - row.fundingUsdt - closingFee).toFixed(8));
    await db.batch([
      db.update(trades).set({ status: "closed", closedAt: now, exitValueUsdt: exitValue, feesUsdt: row.feesUsdt + closingFee, realizedNetPnlUsdt: pnl, updatedAt: now }).where(eq(trades.id, id)),
      db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, row.decisionId || "")),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "simulated_order.closed", subjectType: "trade", subjectId: id, afterJson: JSON.stringify({ orderId: row.exchangeOrderId, side: row.side, exitPrice: quote.price, priceProvider: quote.provider, priceObservedAt: quote.observedAt, exitValue, realizedNetPnlUsdt: pnl, closingFeeUsdt: closingFee, strategyId: row.communityStrategyId }) }),
    ]);
    return Response.json({ status: "closed", fillPrice: quote.price, priceProvider: quote.provider, realizedNetPnlUsdt: pnl, message: "模拟持仓已按后台行情平仓并完成收益归因" });
  } catch (error) {
    return responseError(error);
  }
}
