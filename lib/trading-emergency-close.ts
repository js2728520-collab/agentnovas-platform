import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, exchangeAccounts, platformDecisions, trades } from "@/db/schema";
import { decryptExchangeCredential } from "@/lib/exchange-credentials";
import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder } from "@/lib/okx-demo-execution";

type OpenTrade = typeof trades.$inferSelect;

export type EmergencyCloseResult = {
  tradeId: string;
  symbol: string;
  status: "closed" | "pending" | "unsupported" | "failed";
  message: string;
};

export async function closeOkxDemoTrade(position: OpenTrade, account: typeof exchangeAccounts.$inferSelect, now: string): Promise<EmergencyCloseResult> {
  if (position.side !== "buy") return { tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "当前仅支持 OKX Demo 现货多仓的一键平仓" };
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
        if (position.decisionId) statements.push(getDb().update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, position.decisionId)) as never);
        await getDb().batch(statements);
        return { tradeId: position.id, symbol: position.symbol, status: "closed", message: "OKX Demo 平仓回执已确认" };
      }
      if (["canceled", "mmp_canceled", "rejected"].includes(order.state)) {
        await getDb().update(trades).set({ status: "filled", closeExchangeOrderId: null, updatedAt: now }).where(eq(trades.id, position.id));
        return { tradeId: position.id, symbol: position.symbol, status: "failed", message: "原 OKX Demo 平仓单未成交，仓位仍然存在" };
      }
      return { tradeId: position.id, symbol: position.symbol, status: "pending", message: "已有 OKX Demo 平仓单，等待交易所回执" };
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
      return { tradeId: position.id, symbol: position.symbol, status: "pending", message: "OKX Demo 平仓单已提交，等待成交回执" };
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
    return { tradeId: position.id, symbol: position.symbol, status: "closed", message: "OKX Demo 已完成平仓" };
  } catch (error) {
    return { tradeId: position.id, symbol: position.symbol, status: "failed", message: error instanceof Error ? error.message : "OKX Demo 平仓请求失败" };
  }
}
