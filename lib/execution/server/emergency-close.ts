/**
 * OKX Demo 一键平仓。
 *
 * 从 lib/trading-emergency-close.ts 迁到执行边界内（ADR-0019 第 1 步）：
 * 它需要客户凭证，因此必须与解密点住在同一个边界里，将来一起搬进独立执行服务进程。
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "../../../db/index.ts";
import { auditLogs, exchangeAccounts, platformDecisions, trades } from "../../../db/schema.ts";
import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder } from "../../okx-demo-execution.ts";
import { deriveClientOrderId } from "../../../packages/domain/src/execution/client-order-id.ts";

import { loadExchangeCredential } from "./credential-access.ts";

type OpenTrade = typeof trades.$inferSelect;

export type EmergencyCloseResult = {
  tradeId: string;
  symbol: string;
  status: "closed" | "pending" | "unsupported" | "failed";
  message: string;
};

async function closeOkxDemoTrade(position: OpenTrade, account: typeof exchangeAccounts.$inferSelect, now: string): Promise<EmergencyCloseResult> {
  if (position.side !== "buy") return { tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "当前仅支持 OKX Demo 现货多仓的一键平仓" };
  try {
    // 走凭证代理而不是直接解密：解密只允许发生在 lib/execution/credential-access.ts
    // （ADR-0019），由架构边界规则强制。
    const { credentials } = await loadExchangeCredential({
      accountId: account.id,
      customerId: account.customerId,
    });
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
      // 确定性派生，不掺时间戳和随机数。
      //
      // 这里原本是 `EST${Date.now()}${uuid}`——请求发出去而响应丢失时（10 秒超时），
      // 客户或运维再点一次一键平仓会得到一个**全新的** id，交易所没有任何判重依据，
      // 于是卖出双倍数量。一键平仓恰恰是最可能被连点的操作。
      //
      // 见 packages/domain/src/execution/client-order-id.ts 开头那条唯一的规则。
      clientOrderId: await deriveClientOrderId({
        decisionRoundId: position.id,
        portfolioId: account.id,
        action: "emergency_exit",
      }),
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

/**
 * 跨进程入口：只收 id，行由本进程自己读。
 *
 * 原来 Web 层把整行 `exchangeAccounts` 传进来——那一行里含
 * `encryptedCredentialRef`，等于密文在进程间流动。改成只传 id 之后，Web 层连密文
 * 都拿不到。
 *
 * `customerId` 是调用方的声明，本进程仍然自己校验归属：共享密钥只证明「请求来自
 * 我们自己的 Web 进程」，不证明「这个客户拥有这笔仓位」。Web 层被攻破时这一层
 * 仍然挡住越权平仓。
 */
export async function closeOkxDemoTradeById(input: {
  tradeId: string;
  accountId: string;
  customerId: string;
  now: string;
}): Promise<EmergencyCloseResult> {
  const db = getDb();
  const position = (await db.select().from(trades)
    .where(and(eq(trades.id, input.tradeId), eq(trades.customerId, input.customerId))).limit(1))[0];
  if (!position) {
    return { tradeId: input.tradeId, symbol: "", status: "failed", message: "仓位不存在或不属于当前账户" };
  }
  const account = (await db.select().from(exchangeAccounts)
    .where(and(eq(exchangeAccounts.id, input.accountId), eq(exchangeAccounts.customerId, input.customerId))).limit(1))[0];
  if (!account) {
    return { tradeId: position.id, symbol: position.symbol, status: "failed", message: "绑定账户不存在" };
  }
  return closeOkxDemoTrade(position, account, input.now);
}
