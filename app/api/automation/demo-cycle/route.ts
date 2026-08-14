import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  collectionCases,
  communityStrategies,
  exchangeAccounts,
  memberships,
  platformDecisions,
  strategySubscriptions,
  trades,
} from "@/db/schema";
import { evaluateDemoStrategySignal } from "@/lib/demo-strategy-signal";
import { decryptExchangeCredential } from "@/lib/exchange-credentials";
import { getSpotCandles, getSpotPrice, marketDataIsHealthy, normalizeSpotSymbol } from "@/lib/market-data";
import { membershipAccess } from "@/lib/membership-rules";
import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder } from "@/lib/okx-demo-execution";

type CycleResult = {
  subscriptionId: string;
  strategyId: string;
  status: "entered" | "closed" | "held" | "skipped" | "rejected" | "failed";
  message: string;
  decisionId?: string;
  tradeId?: string;
};

function secretMatches(actual: string | null, expected: string | undefined) {
  if (!actual || !expected || expected.length < 24 || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function objectFromJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstSymbol(strategy: typeof communityStrategies.$inferSelect, specification: Record<string, unknown>) {
  try {
    const symbols = JSON.parse(strategy.symbolsJson || "[]") as unknown;
    if (Array.isArray(symbols) && symbols.length) return normalizeSpotSymbol(String(symbols[0]));
  } catch {
    // The normalized specification below will reject invalid or missing configuration.
  }
  return normalizeSpotSymbol(String(specification.symbol || "BTCUSDT"));
}

async function processSubscription(subscription: typeof strategySubscriptions.$inferSelect): Promise<CycleResult> {
  const db = getDb();
  const now = new Date().toISOString();
  if (!subscription.exchangeAccountId) return { subscriptionId: subscription.id, strategyId: subscription.strategyId, status: "rejected", message: "未绑定模拟交易账户" };

  const [strategy, account, membership, blockedCollection] = await Promise.all([
    db.select().from(communityStrategies).where(and(eq(communityStrategies.id, subscription.strategyId), eq(communityStrategies.status, "published"))).limit(1).then((rows) => rows[0]),
    db.select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, subscription.exchangeAccountId!), eq(exchangeAccounts.customerId, subscription.customerId))).limit(1).then((rows) => rows[0]),
    db.select().from(memberships).where(and(eq(memberships.customerId, subscription.customerId), inArray(memberships.status, ["active", "grace"]))).limit(1).then((rows) => rows[0]),
    db.select({ id: collectionCases.id }).from(collectionCases).where(and(eq(collectionCases.customerId, subscription.customerId), eq(collectionCases.newEntriesAllowed, false))).limit(1).then((rows) => rows[0]),
  ]);

  if (!strategy) return { subscriptionId: subscription.id, strategyId: subscription.strategyId, status: "rejected", message: "策略未上架或已暂停" };
  if (!account || account.environment !== "demo" || account.status !== "active" || !account.canRead || !account.canTrade) {
    return { subscriptionId: subscription.id, strategyId: strategy.id, status: "rejected", message: "模拟账户权限或连接状态未通过" };
  }
  const access = membership ? membershipAccess(now, membership) : null;
  const newEntriesAllowed = Boolean(access?.newEntriesAllowed) && !blockedCollection && process.env.PLATFORM_EMERGENCY_STOP !== "true";
  const rawSpecification = objectFromJson(strategy.specificationJson);
  const symbol = firstSymbol(strategy, rawSpecification);
  const period = String(rawSpecification.period || "15m").toLowerCase();
  const market = await getSpotCandles(symbol, period, 121);
  const closedCandles = market.candles.slice(0, -1);
  const openTrades = await db.select().from(trades).where(and(
    eq(trades.customerId, subscription.customerId),
    eq(trades.exchangeAccountId, account.id),
    eq(trades.communityStrategyId, strategy.id),
    isNull(trades.closedAt),
  )).limit(20);
  const signal = evaluateDemoStrategySignal({ ...rawSpecification, symbol, period: market.interval }, closedCandles, openTrades.length > 0);
  const previousRisk = objectFromJson(subscription.riskCheckJson);
  const quote = await getSpotPrice(symbol);
  const runtimeEvidence = {
    engine: "deterministic-demo-signal-v1",
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    subscriptionId: subscription.id,
    signal,
    marketProvider: market.provider,
    marketObservedAt: market.observedAt,
    quote,
    membershipStatus: access?.status || "unavailable",
    collectionBlocked: Boolean(blockedCollection),
    emergencyStop: process.env.PLATFORM_EMERGENCY_STOP === "true",
    evaluatedAt: now,
  };

  let activePosition = openTrades[0];
  const useOkxDemo = process.env.OKX_DEMO_EXECUTION_ENABLED === "true" && account.exchange.toUpperCase() === "OKX";
  if (activePosition?.executionVenue === "okx_demo" && ["submitted", "closing"].includes(activePosition.status)) {
    const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
    const pendingClose = activePosition.status === "closing" && activePosition.closeExchangeOrderId;
    const synchronized = await getOkxDemoOrder({ credentials, symbol, orderId: pendingClose ? activePosition.closeExchangeOrderId! : activePosition.exchangeOrderId });
    if (synchronized.state === "filled" && synchronized.filledQuantity > 0 && synchronized.averagePrice > 0) {
      if (!pendingClose) {
        const entryValueUsdt = synchronized.averagePrice * synchronized.filledQuantity;
        const feesUsdt = okxFeeInUsdt(synchronized);
        await db.update(trades).set({ status: "filled", quantity: synchronized.filledQuantity, entryValueUsdt, feesUsdt, updatedAt: now }).where(eq(trades.id, activePosition.id));
        if (activePosition.decisionId) {
          await db.update(platformDecisions).set({
            status: "approved",
            evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "enter", result: "exchange_fill_synchronized", exchangeOrder: synchronized }),
            updatedAt: now,
          }).where(eq(platformDecisions.id, activePosition.decisionId));
        }
        await db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorUserId: null,
          action: "automation.okx_demo_entry.filled",
          subjectType: "trade",
          subjectId: activePosition.id,
          afterJson: JSON.stringify({ exchangeOrder: synchronized, entryValueUsdt, feesUsdt, runtimeEvidence }),
        });
        activePosition = { ...activePosition, status: "filled", quantity: synchronized.filledQuantity, entryValueUsdt, feesUsdt };
      } else {
        const exitValue = synchronized.averagePrice * synchronized.filledQuantity;
        const closingFee = okxFeeInUsdt(synchronized);
        const grossPnl = activePosition.side === "sell" ? activePosition.entryValueUsdt - exitValue : exitValue - activePosition.entryValueUsdt;
        const pnl = Number((grossPnl - activePosition.feesUsdt - activePosition.fundingUsdt - closingFee).toFixed(8));
        const closeReason = String(previousRisk.pendingCloseReason || "exchange_fill_sync");
        const decisionId = String(previousRisk.pendingExitDecisionId || crypto.randomUUID());
        if (previousRisk.pendingExitDecisionId) {
          await db.update(platformDecisions).set({ status: "completed", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "close", closeReason, exchangeOrder: synchronized }), updatedAt: now }).where(eq(platformDecisions.id, decisionId));
        } else {
          await db.insert(platformDecisions).values({ id: decisionId, customerId: subscription.customerId, exchangeAccountId: account.id, strategyCode: `community:${strategy.id}`, strategyVersion: `v${strategy.version}`, symbol, status: "completed", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "close", closeReason, exchangeOrder: synchronized }) });
        }
        await db.batch([
          db.update(trades).set({ status: "closed", closedAt: now, exitValueUsdt: exitValue, feesUsdt: activePosition.feesUsdt + closingFee, realizedNetPnlUsdt: pnl, updatedAt: now }).where(eq(trades.id, activePosition.id)),
          db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, activePosition.decisionId || "")),
          db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "closed", closeReason, realizedNetPnlUsdt: pnl, exchangeOrder: synchronized }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id)),
          db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "automation.okx_demo_position.closed", subjectType: "trade", subjectId: activePosition.id, afterJson: JSON.stringify({ exitDecisionId: decisionId, closeReason, realizedNetPnlUsdt: pnl, exchangeOrder: synchronized, runtimeEvidence }) }),
        ]);
        return { subscriptionId: subscription.id, strategyId: strategy.id, status: "closed", message: "OKX Demo 平仓回执已同步并完成收益归因", decisionId, tradeId: activePosition.id };
      }
    } else if (["canceled", "mmp_canceled", "rejected"].includes(synchronized.state)) {
      if (pendingClose) {
        const decisionId = String(previousRisk.pendingExitDecisionId || "");
        await db.update(trades).set({ status: "filled", closeExchangeOrderId: null, updatedAt: now }).where(eq(trades.id, activePosition.id));
        if (decisionId) {
          await db.update(platformDecisions).set({
            status: "cancelled",
            evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "close", result: "exchange_order_rejected", exchangeOrder: synchronized }),
            updatedAt: now,
          }).where(eq(platformDecisions.id, decisionId));
        }
        await db.batch([
          db.update(strategySubscriptions).set({
            lastRiskCheckAt: now,
            riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "close_rejected_position_remains_open", exchangeOrder: synchronized }),
            updatedAt: now,
          }).where(eq(strategySubscriptions.id, subscription.id)),
          db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "automation.okx_demo_close.rejected", subjectType: "trade", subjectId: activePosition.id, afterJson: JSON.stringify({ decisionId: decisionId || null, exchangeOrder: synchronized, runtimeEvidence }) }),
        ]);
        return { subscriptionId: subscription.id, strategyId: strategy.id, status: "failed", message: "OKX Demo 平仓单未成交，仓位保持并等待下一轮风控", tradeId: activePosition.id };
      }
      await db.update(trades).set({ status: synchronized.state, closedAt: now, updatedAt: now }).where(eq(trades.id, activePosition.id));
      if (activePosition.decisionId) {
        await db.update(platformDecisions).set({ status: "cancelled", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "enter", result: "exchange_order_rejected", exchangeOrder: synchronized }), updatedAt: now }).where(eq(platformDecisions.id, activePosition.decisionId));
      }
      await db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "automation.okx_demo_entry.rejected", subjectType: "trade", subjectId: activePosition.id, afterJson: JSON.stringify({ exchangeOrder: synchronized, runtimeEvidence }) });
      return { subscriptionId: subscription.id, strategyId: strategy.id, status: "failed", message: "OKX Demo 开仓单已取消或拒绝，未形成仓位", tradeId: activePosition.id };
    } else {
      await db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...previousRisk, ...runtimeEvidence, result: pendingClose ? "awaiting_close_fill" : "awaiting_entry_fill", exchangeOrder: synchronized }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id));
      return { subscriptionId: subscription.id, strategyId: strategy.id, status: "held", message: pendingClose ? "OKX Demo 平仓单等待成交回执" : "OKX Demo 开仓单等待成交回执", tradeId: activePosition.id };
    }
  }
  if (previousRisk.lastCandleCloseTime === signal.metrics.candleCloseTime) {
    return { subscriptionId: subscription.id, strategyId: strategy.id, status: "skipped", message: "该根完整K线已经判定，幂等保护已跳过" };
  }
  if (activePosition) {
    const entryPrice = activePosition.quantity > 0 ? activePosition.entryValueUsdt / activePosition.quantity : 0;
    const changePct = entryPrice > 0 ? (quote.price - entryPrice) / entryPrice * 100 : 0;
    const hardStopPct = Math.min(subscription.stopLossPct, signal.specification.stopLoss);
    const stopTriggered = changePct <= -Math.abs(hardStopPct);
    const takeProfitTriggered = changePct >= Math.abs(signal.specification.takeProfit);
    if (signal.action !== "exit" && !stopTriggered && !takeProfitTriggered) {
      await db.update(strategySubscriptions).set({
        lastRiskCheckAt: now,
        riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, positionChangePct: changePct, hardStopPct, result: "hold_open_position" }),
        updatedAt: now,
      }).where(eq(strategySubscriptions.id, subscription.id));
      return { subscriptionId: subscription.id, strategyId: strategy.id, status: "held", message: "已有模拟仓位，当前未触发止损、止盈或退出条件" };
    }

    let exitValue = quote.price * activePosition.quantity;
    let closingFee = Number((exitValue * 0.001).toFixed(8));
    const decisionId = crypto.randomUUID();
    const closeReason = stopTriggered ? "hard_stop_loss" : takeProfitTriggered ? "take_profit" : "strategy_exit";
    let closeOrder: Awaited<ReturnType<typeof placeOkxDemoMarketOrder>> | null = null;
    if (useOkxDemo) {
      const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
      closeOrder = await placeOkxDemoMarketOrder({ credentials, symbol, side: "sell", quantity: activePosition.quantity, clientOrderId: `ANX${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}` });
      if (closeOrder.state !== "filled" || !(closeOrder.filledQuantity > 0) || !(closeOrder.averagePrice > 0)) {
        await db.batch([
          db.insert(platformDecisions).values({ id: decisionId, customerId: subscription.customerId, exchangeAccountId: account.id, strategyCode: `community:${strategy.id}`, strategyVersion: `v${strategy.version}`, symbol, status: "executing", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "close", closeReason, exchangeOrder: closeOrder }) }),
          db.update(trades).set({ status: "closing", closeExchangeOrderId: closeOrder.orderId, updatedAt: now }).where(eq(trades.id, activePosition.id)),
          db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "awaiting_close_fill", pendingCloseReason: closeReason, pendingExitDecisionId: decisionId, exchangeOrder: closeOrder }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id)),
          db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "automation.okx_demo_close.submitted", subjectType: "trade", subjectId: activePosition.id, afterJson: JSON.stringify({ exitDecisionId: decisionId, closeReason, exchangeOrder: closeOrder, runtimeEvidence }) }),
        ]);
        return { subscriptionId: subscription.id, strategyId: strategy.id, status: "held", message: "OKX Demo 平仓单已提交，等待成交回执", decisionId, tradeId: activePosition.id };
      }
      exitValue = closeOrder.averagePrice * closeOrder.filledQuantity;
      closingFee = okxFeeInUsdt(closeOrder);
    }
    const actualGrossPnl = activePosition.side === "sell" ? activePosition.entryValueUsdt - exitValue : exitValue - activePosition.entryValueUsdt;
    const pnl = Number((actualGrossPnl - activePosition.feesUsdt - activePosition.fundingUsdt - closingFee).toFixed(8));
    await db.batch([
      db.insert(platformDecisions).values({ id: decisionId, customerId: subscription.customerId, exchangeAccountId: account.id, strategyCode: `community:${strategy.id}`, strategyVersion: `v${strategy.version}`, symbol, status: "completed", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "close", closeReason, positionChangePct: changePct, exchangeOrder: closeOrder }) }),
      db.update(trades).set({ status: "closed", closedAt: now, closeExchangeOrderId: closeOrder?.orderId, exitValueUsdt: exitValue, feesUsdt: activePosition.feesUsdt + closingFee, realizedNetPnlUsdt: pnl, updatedAt: now }).where(eq(trades.id, activePosition.id)),
      db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, activePosition.decisionId || "")),
      db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "closed", closeReason, realizedNetPnlUsdt: pnl }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: useOkxDemo ? "automation.okx_demo_position.closed" : "automation.demo_position.closed", subjectType: "trade", subjectId: activePosition.id, afterJson: JSON.stringify({ exitDecisionId: decisionId, closeReason, exitPrice: closeOrder?.averagePrice || quote.price, realizedNetPnlUsdt: pnl, exchangeOrder: closeOrder, runtimeEvidence }) }),
    ]);
    return { subscriptionId: subscription.id, strategyId: strategy.id, status: "closed", message: `模拟仓位已按${closeReason}平仓`, decisionId, tradeId: activePosition.id };
  }

  if (signal.action !== "enter") {
    await db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "hold_no_position" }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyId: strategy.id, status: "held", message: signal.reason };
  }
  if (!newEntriesAllowed) {
    await db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: "entry_rejected" }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyId: strategy.id, status: "rejected", message: "出现入场信号，但会员、催收或平台安全状态禁止新开仓" };
  }

  const today = now.slice(0, 10);
  const customerTrades = await db.select().from(trades).where(eq(trades.customerId, subscription.customerId));
  const todayPnl = customerTrades.filter((row) => (row.closedAt || row.updatedAt || "").startsWith(today)).reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0);
  const dailyLossLimitUsdt = Math.abs(Number(process.env.MAX_DAILY_LOSS_USDT || 3_000));
  if (todayPnl <= -dailyLossLimitUsdt) return { subscriptionId: subscription.id, strategyId: strategy.id, status: "rejected", message: "已触发客户单日亏损限制" };
  const simulatedEquityUsdt = Number(process.env.SIMULATED_EQUITY_USDT || 10_000);
  const notional = simulatedEquityUsdt * subscription.capitalPct / 100;
  const quantity = Number((notional / quote.price).toFixed(8));
  if (!(quantity > 0)) return { subscriptionId: subscription.id, strategyId: strategy.id, status: "failed", message: "模拟下单数量计算无效" };
  const decisionId = crypto.randomUUID();
  const tradeId = crypto.randomUUID();
  let orderId = `AUTO-SIM-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  let filledQuantity = quantity;
  let entryValueUsdt = notional;
  let entryFee = Number((notional * 0.001).toFixed(8));
  let orderStatus = "filled";
  let venue: "internal_demo" | "okx_demo" = "internal_demo";
  let entryOrder: Awaited<ReturnType<typeof placeOkxDemoMarketOrder>> | null = null;
  if (useOkxDemo) {
    const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
    entryOrder = await placeOkxDemoMarketOrder({ credentials, symbol, side: "buy", notionalUsdt: notional, clientOrderId: `ANE${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}` });
    orderId = entryOrder.orderId;
    venue = "okx_demo";
    orderStatus = entryOrder.state === "filled" ? "filled" : "submitted";
    if (entryOrder.filledQuantity > 0 && entryOrder.averagePrice > 0) {
      filledQuantity = entryOrder.filledQuantity;
      entryValueUsdt = entryOrder.filledQuantity * entryOrder.averagePrice;
      entryFee = okxFeeInUsdt(entryOrder);
    } else {
      entryFee = 0;
    }
  }
  const hardRiskChecks = ["demo_only", "published_strategy", "membership_access", "collection_status", "platform_emergency_stop", "account_permissions", "market_freshness", "daily_loss_limit", "subscription_position_limit", "same_candle_idempotency"];
  await db.batch([
    db.insert(platformDecisions).values({ id: decisionId, customerId: subscription.customerId, exchangeAccountId: account.id, strategyCode: `community:${strategy.id}`, strategyVersion: `v${strategy.version}`, symbol, status: orderStatus === "filled" ? "approved" : "executing", evidenceJson: JSON.stringify({ ...runtimeEvidence, action: "enter", hardRiskChecks, notional, quantity: filledQuantity, dailyLossLimitUsdt, exchangeOrder: entryOrder }) }),
    db.insert(trades).values({ id: tradeId, exchangeAccountId: account.id, customerId: subscription.customerId, decisionId, strategyCode: `community:${strategy.id}`, communityStrategyId: strategy.id, exchangeOrderId: orderId, executionVenue: venue, symbol, side: "buy", origin: "platform", status: orderStatus, openedAt: now, quantity: filledQuantity, entryValueUsdt, exitValueUsdt: 0, feesUsdt: entryFee, fundingUsdt: 0, realizedNetPnlUsdt: 0 }),
    db.update(strategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseTime: signal.metrics.candleCloseTime, result: orderStatus === "filled" ? "entered" : "awaiting_entry_fill", decisionId, tradeId, hardRiskChecks, exchangeOrder: entryOrder }), updatedAt: now }).where(eq(strategySubscriptions.id, subscription.id)),
    db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: useOkxDemo ? "automation.okx_demo_entry.submitted" : "automation.demo_position.opened", subjectType: "trade", subjectId: tradeId, afterJson: JSON.stringify({ decisionId, orderId, entryPrice: entryOrder?.averagePrice || quote.price, notional: entryValueUsdt, quantity: filledQuantity, orderStatus, exchangeOrder: entryOrder, runtimeEvidence, hardRiskChecks }) }),
  ]);
  return { subscriptionId: subscription.id, strategyId: strategy.id, status: "entered", message: useOkxDemo ? (orderStatus === "filled" ? "OKX Demo 已成交并保存真实回执" : "OKX Demo 已受理订单，等待成交回执") : "策略信号与硬风控均通过，已生成可审计模拟成交", decisionId, tradeId };
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get("x-automation-key"), process.env.AUTOMATION_INTERNAL_SECRET)) {
    return Response.json({ error: "自动运行密钥无效" }, { status: 401 });
  }
  if (!(await marketDataIsHealthy())) return Response.json({ error: "行情源健康检查失败，本轮不执行" }, { status: 503 });
  const limit = Math.min(500, Math.max(1, Number(process.env.AUTOMATION_MAX_SUBSCRIPTIONS_PER_RUN || 100)));
  const subscriptions = await getDb().select().from(strategySubscriptions).where(eq(strategySubscriptions.status, "active")).limit(limit);
  const results: CycleResult[] = [];
  for (const subscription of subscriptions) {
    try {
      results.push(await processSubscription(subscription));
    } catch (error) {
      results.push({ subscriptionId: subscription.id, strategyId: subscription.strategyId, status: "failed", message: error instanceof Error ? error.message : "自动模拟运行失败" });
    }
  }
  const counts = results.reduce<Record<string, number>>((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});
  return Response.json({ mode: "demo", processed: results.length, counts, results, completedAt: new Date().toISOString() });
}
