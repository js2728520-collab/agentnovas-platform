import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  collectionCases,
  exchangeAccounts,
  memberships,
  platformDecisions,
  platformFollowPolicies,
  platformStrategySubscriptions,
  trades,
} from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { decryptExchangeCredential } from "@/lib/exchange-credentials";
import { evaluateFollowPolicy } from "@/lib/follow-policy";
import { getSpotCandles, getSpotPrice, marketDataIsHealthy } from "@/lib/market-data";
import { membershipAccess } from "@/lib/membership-rules";
import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder } from "@/lib/okx-demo-execution";
import {
  evaluatePlatformStrategy,
  isPlatformStrategyCode,
  PLATFORM_AI_STRATEGIES,
  type PlatformStrategySignal,
} from "@/lib/platform-ai-strategies";
import { runtimeSetting } from "@/lib/runtime-setting";

type Subscription = typeof platformStrategySubscriptions.$inferSelect;
type Position = typeof trades.$inferSelect;
type CycleStatus = "entered" | "closed" | "held" | "skipped" | "rejected" | "failed";
type CycleResult = { subscriptionId: string; strategyCode: string; status: CycleStatus; message: string; decisionId?: string; tradeId?: string };

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

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function selectSignal(rows: Array<{ symbol: string; signal: PlatformStrategySignal }>) {
  return [...rows].sort((left, right) => {
    const actionScore = (value: PlatformStrategySignal["action"]) => value === "exit" ? 3 : value === "enter" ? 2 : 1;
    return actionScore(right.signal.action) - actionScore(left.signal.action) || right.signal.confidence - left.signal.confidence;
  })[0];
}

async function insertDecision(input: {
  subscription: Subscription;
  accountId: string;
  symbol: string;
  strategyVersion: string;
  status: "proposed" | "risk_rejected" | "approved" | "executing" | "completed" | "cancelled";
  evidence: Record<string, unknown>;
  riskApproved?: boolean;
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().batch([
    getDb().insert(platformDecisions).values({
      id,
      customerId: input.subscription.customerId,
      exchangeAccountId: input.accountId,
      strategyCode: input.subscription.strategyCode,
      strategyVersion: input.strategyVersion,
      agentTaskId: crypto.randomUUID(),
      riskApprovalId: input.riskApproved ? crypto.randomUUID() : null,
      symbol: input.symbol,
      status: input.status,
      evidenceJson: JSON.stringify(input.evidence),
    }),
    getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: null,
      action: `platform_ai.decision.${input.status}`,
      subjectType: "platform_decision",
      subjectId: id,
      afterJson: JSON.stringify({ strategyCode: input.subscription.strategyCode, symbol: input.symbol, status: input.status, recordedAt: now }),
    }),
  ]);
  return id;
}

async function synchronizePendingPosition(options: {
  subscription: Subscription;
  position: Position;
  symbol: string;
  evidence: Record<string, unknown>;
}) {
  if (options.position.executionVenue !== "okx_demo" || !["submitted", "closing"].includes(options.position.status)) return null;
  const db = getDb();
  const account = (await db.select().from(exchangeAccounts).where(eq(exchangeAccounts.id, options.position.exchangeAccountId)).limit(1))[0];
  if (!account) throw new Error("待同步订单的交易账户不存在");
  const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
  const closing = options.position.status === "closing";
  const pendingRisk = objectFromJson(options.subscription.riskCheckJson);
  const pendingDecisionId = typeof pendingRisk.decisionId === "string" ? pendingRisk.decisionId : "";
  const orderId = closing ? options.position.closeExchangeOrderId : options.position.exchangeOrderId;
  if (!orderId) throw new Error("待同步订单编号缺失");
  const order = await getOkxDemoOrder({ credentials, symbol: options.symbol, orderId });
  const now = new Date().toISOString();
  if (order.state === "filled" && order.filledQuantity > 0 && order.averagePrice > 0) {
    if (!closing) {
      const entryValueUsdt = order.averagePrice * order.filledQuantity;
      await db.batch([
        db.update(trades).set({ status: "filled", quantity: order.filledQuantity, entryValueUsdt, feesUsdt: okxFeeInUsdt(order), updatedAt: now }).where(eq(trades.id, options.position.id)),
        db.update(platformDecisions).set({ status: "approved", updatedAt: now }).where(eq(platformDecisions.id, options.position.decisionId || "")),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "platform_ai.okx_demo_entry.filled", subjectType: "trade", subjectId: options.position.id, afterJson: JSON.stringify({ order, evidence: options.evidence }) }),
      ]);
      return { status: "filled" as const, message: "OKX 验证环境开仓回执已同步", tradeId: options.position.id };
    }
    const exitValueUsdt = order.averagePrice * order.filledQuantity;
    const closingFee = okxFeeInUsdt(order);
    const gross = options.position.side === "sell" ? options.position.entryValueUsdt - exitValueUsdt : exitValueUsdt - options.position.entryValueUsdt;
    const pnl = Number((gross - options.position.feesUsdt - options.position.fundingUsdt - closingFee).toFixed(8));
    await db.batch([
      db.update(trades).set({ status: "closed", closedAt: now, exitValueUsdt, feesUsdt: options.position.feesUsdt + closingFee, realizedNetPnlUsdt: pnl, updatedAt: now }).where(eq(trades.id, options.position.id)),
      db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, options.position.decisionId || "")),
      ...(pendingDecisionId ? [db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, pendingDecisionId))] : []),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "platform_ai.okx_demo_close.filled", subjectType: "trade", subjectId: options.position.id, afterJson: JSON.stringify({ order, pnl, evidence: options.evidence }) }),
    ]);
    return { status: "closed" as const, message: "OKX 验证环境平仓回执已同步", tradeId: options.position.id };
  }
  if (["canceled", "mmp_canceled", "rejected"].includes(order.state)) {
    await db.batch([
      db.update(trades).set({ status: closing ? "filled" : order.state, closeExchangeOrderId: closing ? null : options.position.closeExchangeOrderId, closedAt: closing ? null : now, updatedAt: now }).where(eq(trades.id, options.position.id)),
      db.update(platformDecisions).set({ status: closing ? "approved" : "cancelled", updatedAt: now }).where(eq(platformDecisions.id, options.position.decisionId || "")),
      ...(pendingDecisionId ? [db.update(platformDecisions).set({ status: "cancelled", updatedAt: now }).where(eq(platformDecisions.id, pendingDecisionId))] : []),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: "platform_ai.okx_demo_order.rejected", subjectType: "trade", subjectId: options.position.id, afterJson: JSON.stringify({ order, evidence: options.evidence }) }),
    ]);
    return { status: "rejected" as const, message: closing ? "平仓指令未成交，原仓位继续受风控管理" : "开仓指令被交易所取消或拒绝", tradeId: options.position.id };
  }
  return { status: "pending" as const, message: closing ? "平仓指令等待交易所回执" : "开仓指令等待交易所回执", tradeId: options.position.id };
}

async function processSubscription(subscription: Subscription): Promise<CycleResult> {
  const db = getDb();
  const now = new Date().toISOString();
  if (!isPlatformStrategyCode(subscription.strategyCode)) return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "rejected", message: "平台策略编号无效" };
  const definition = PLATFORM_AI_STRATEGIES[subscription.strategyCode];
  const [account, membership, blockedCollection, policy, openPositions, customerTrades] = await Promise.all([
    db.select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, subscription.exchangeAccountId), eq(exchangeAccounts.customerId, subscription.customerId))).limit(1).then((rows) => rows[0]),
    db.select().from(memberships).where(and(eq(memberships.customerId, subscription.customerId), inArray(memberships.status, ["active", "grace"]))).limit(1).then((rows) => rows[0]),
    db.select({ id: collectionCases.id }).from(collectionCases).where(and(eq(collectionCases.customerId, subscription.customerId), eq(collectionCases.newEntriesAllowed, false))).limit(1).then((rows) => rows[0]),
    db.select({ allowFollowWithoutWithdrawal: platformFollowPolicies.allowFollowWithoutWithdrawal }).from(platformFollowPolicies).where(eq(platformFollowPolicies.id, "default")).limit(1).then((rows) => rows[0]),
    db.select().from(trades).where(and(eq(trades.customerId, subscription.customerId), eq(trades.exchangeAccountId, subscription.exchangeAccountId), eq(trades.strategyCode, subscription.strategyCode), isNull(trades.closedAt))).limit(10),
    db.select().from(trades).where(eq(trades.customerId, subscription.customerId)).limit(3000),
  ]);
  if (!account || account.environment !== "demo" || account.status !== "active" || !account.canRead || !account.canTrade) {
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "rejected", message: "验证账户连接或交易权限未通过" };
  }

  const existingPosition = openPositions[0];
  const symbols = existingPosition ? [existingPosition.symbol] : definition.symbols;
  const marketRows = (await Promise.allSettled(symbols.map(async (symbol) => {
    const market = await getSpotCandles(symbol, definition.interval, 121);
    const candles = market.candles.slice(0, -1);
    return { symbol, market, signal: evaluatePlatformStrategy(definition, symbol, candles, Boolean(existingPosition)) };
  }))).flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!marketRows.length) throw new Error("所有候选交易品种的实时K线均不可用");
  const selected = selectSignal(marketRows);
  const quote = await getSpotPrice(selected.symbol);
  const previousRisk = objectFromJson(subscription.riskCheckJson);
  const lastCandles = stringRecord(previousRisk.lastCandleCloseBySymbol);
  const followPolicy = evaluateFollowPolicy({
    allowFollowWithoutWithdrawal: Boolean(policy?.allowFollowWithoutWithdrawal),
    withdrawalAuthorized: Boolean(account.withdrawalAuthorized),
    publicationMode: "marketplace",
  });
  const access = membership ? membershipAccess(now, membership) : null;
  const newEntriesAllowed = Boolean(access?.newEntriesAllowed)
    && !blockedCollection
    && followPolicy.allowed
    && runtimeSetting("PLATFORM_EMERGENCY_STOP") !== "true";
  const hardChecks = {
    demoOnly: account.environment === "demo",
    accountActive: account.status === "active",
    canRead: account.canRead,
    canTrade: account.canTrade,
    membership: Boolean(access?.newEntriesAllowed),
    collection: !blockedCollection,
    followPolicy: followPolicy.allowed,
    emergencyStopClear: runtimeSetting("PLATFORM_EMERGENCY_STOP") !== "true",
    riskModelApproved: selected.signal.riskReview.approved,
    noLeverage: true,
  };
  const runtimeEvidence = {
    engine: "platform-ai-deterministic-v1",
    strategyCode: definition.code,
    strategyName: definition.name,
    strategyVersion: definition.version,
    subscriptionId: subscription.id,
    symbol: selected.symbol,
    interval: definition.interval,
    signal: selected.signal,
    agentMessages: selected.signal.agentMessages,
    agentName: "AI 决策官",
    agentMessage: `${definition.name}：${selected.signal.reason}`,
    marketProvider: selected.market.provider,
    marketObservedAt: selected.market.observedAt,
    quote,
    hardChecks,
    membershipStatus: access?.status || "unavailable",
    manualCollectionRequired: followPolicy.manualCollectionRequired,
    evaluatedAt: now,
  };

  const synchronized = existingPosition ? await synchronizePendingPosition({ subscription, position: existingPosition, symbol: existingPosition.symbol, evidence: runtimeEvidence }) : null;
  if (synchronized?.status === "filled") {
    await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, result: "exchange_entry_synchronized" }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "held", message: synchronized.message, tradeId: synchronized.tradeId };
  }
  if (synchronized?.status === "closed") {
    await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, result: "exchange_close_synchronized" }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "closed", message: synchronized.message, tradeId: synchronized.tradeId };
  }
  if (synchronized?.status === "pending" || synchronized?.status === "rejected") {
    await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, result: synchronized.status }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: synchronized.status === "pending" ? "held" : "failed", message: synchronized.message, tradeId: synchronized.tradeId };
  }

  if (lastCandles[selected.symbol] === selected.signal.metrics.candleCloseTime && !synchronized) {
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "skipped", message: "该根完整K线已经完成决策，幂等保护已跳过" };
  }
  const nextLastCandles = { ...lastCandles, [selected.symbol]: selected.signal.metrics.candleCloseTime };
  const useOkxDemo = runtimeSetting("OKX_DEMO_EXECUTION_ENABLED") === "true" && account.exchange.toUpperCase() === "OKX";

  if (existingPosition) {
    const entryPrice = existingPosition.quantity > 0 ? existingPosition.entryValueUsdt / existingPosition.quantity : 0;
    const changePct = entryPrice > 0 ? (quote.price - entryPrice) / entryPrice * 100 : 0;
    const hardStopPct = Math.min(subscription.stopLossPct, definition.stopLossPct);
    const closeReason = changePct <= -hardStopPct ? "hard_stop_loss" : changePct >= definition.takeProfitPct ? "take_profit" : selected.signal.action === "exit" ? "strategy_exit" : null;
    if (!closeReason) {
      const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: "proposed", evidence: { ...runtimeEvidence, action: "hold", positionChangePct: changePct } });
      await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: "hold_open_position", decisionId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
      return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "held", message: "已有仓位，当前未触发退出或硬止损条件", decisionId, tradeId: existingPosition.id };
    }

    let exitValueUsdt = quote.price * existingPosition.quantity;
    let closingFee = Number((exitValueUsdt * 0.001).toFixed(8));
    let closeOrder: Awaited<ReturnType<typeof placeOkxDemoMarketOrder>> | null = null;
    if (useOkxDemo) {
      const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
      closeOrder = await placeOkxDemoMarketOrder({ credentials, symbol: selected.symbol, side: "sell", quantity: existingPosition.quantity, clientOrderId: `APX${Date.now().toString(36)}${crypto.randomUUID().slice(0, 7)}` });
      if (closeOrder.state !== "filled" || !(closeOrder.averagePrice > 0) || !(closeOrder.filledQuantity > 0)) {
        const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: "executing", evidence: { ...runtimeEvidence, action: "exit", closeReason, exchangeOrder: closeOrder }, riskApproved: true });
        await db.batch([
          db.update(trades).set({ status: "closing", closeExchangeOrderId: closeOrder.orderId, updatedAt: now }).where(eq(trades.id, existingPosition.id)),
          db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: "awaiting_close_fill", decisionId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id)),
        ]);
        return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "held", message: "OKX 验证环境平仓指令已提交，等待成交回执", decisionId, tradeId: existingPosition.id };
      }
      exitValueUsdt = closeOrder.averagePrice * closeOrder.filledQuantity;
      closingFee = okxFeeInUsdt(closeOrder);
    }
    const gross = existingPosition.side === "sell" ? existingPosition.entryValueUsdt - exitValueUsdt : exitValueUsdt - existingPosition.entryValueUsdt;
    const pnl = Number((gross - existingPosition.feesUsdt - existingPosition.fundingUsdt - closingFee).toFixed(8));
    const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: "completed", evidence: { ...runtimeEvidence, action: "exit", closeReason, positionChangePct: changePct, exchangeOrder: closeOrder }, riskApproved: true });
    await db.batch([
      db.update(trades).set({ status: "closed", closedAt: now, closeExchangeOrderId: closeOrder?.orderId, exitValueUsdt, feesUsdt: existingPosition.feesUsdt + closingFee, realizedNetPnlUsdt: pnl, updatedAt: now }).where(eq(trades.id, existingPosition.id)),
      db.update(platformDecisions).set({ status: "completed", updatedAt: now }).where(eq(platformDecisions.id, existingPosition.decisionId || "")),
      db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: "closed", closeReason, pnl, decisionId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: useOkxDemo ? "platform_ai.okx_demo_position.closed" : "platform_ai.validation_position.closed", subjectType: "trade", subjectId: existingPosition.id, afterJson: JSON.stringify({ decisionId, pnl, closeReason, exchangeOrder: closeOrder }) }),
    ]);
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "closed", message: `${definition.name} 已按 ${closeReason} 完成平仓`, decisionId, tradeId: existingPosition.id };
  }

  if (selected.signal.action !== "enter") {
    const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: "proposed", evidence: { ...runtimeEvidence, action: "hold" } });
    await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: "hold_no_position", decisionId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "held", message: selected.signal.reason, decisionId };
  }

  const today = now.slice(0, 10);
  const todayPnl = customerTrades.filter((row) => (row.closedAt || row.updatedAt || "").startsWith(today)).reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0);
  const dailyLossLimitUsdt = Math.abs(Number(runtimeSetting("MAX_DAILY_LOSS_USDT") || 3_000));
  const openExposure = customerTrades.filter((row) => !row.closedAt).reduce((sum, row) => sum + row.entryValueUsdt, 0);
  const validationEquityUsdt = Math.max(100, Number(runtimeSetting("PLATFORM_STRATEGY_VALIDATION_EQUITY_USDT") || 10_000));
  const capitalPct = Math.min(subscription.capitalPct, definition.maxCapitalPct);
  const notional = Number((validationEquityUsdt * capitalPct / 100).toFixed(8));
  const maxExposureUsdt = Math.max(notional, Number(runtimeSetting("PLATFORM_MAX_EXPOSURE_USDT") || 10_000));
  const finalRiskApproved = newEntriesAllowed
    && selected.signal.riskReview.approved
    && todayPnl > -dailyLossLimitUsdt
    && openExposure + notional <= maxExposureUsdt;
  if (!finalRiskApproved) {
    const rejectionReasons = [
      !newEntriesAllowed ? "会员、催收、账户授权或平台紧急开关禁止新开仓" : "",
      !selected.signal.riskReview.approved ? "策略内部反方审查未通过" : "",
      todayPnl <= -dailyLossLimitUsdt ? "客户单日亏损限制已触发" : "",
      openExposure + notional > maxExposureUsdt ? "客户总仓位限制已触发" : "",
    ].filter(Boolean);
    const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: "risk_rejected", evidence: { ...runtimeEvidence, action: "enter", rejectionReasons, todayPnl, dailyLossLimitUsdt, openExposure, maxExposureUsdt } });
    await db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: "risk_rejected", rejectionReasons, decisionId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id));
    return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "rejected", message: rejectionReasons.join("；"), decisionId };
  }

  let quantity = Number((notional / quote.price).toFixed(8));
  let entryValueUsdt = notional;
  let entryFee = Number((notional * 0.001).toFixed(8));
  let orderId = `PLATFORM-VALIDATION-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  let orderStatus = "filled";
  let executionVenue: "internal_demo" | "okx_demo" = "internal_demo";
  let entryOrder: Awaited<ReturnType<typeof placeOkxDemoMarketOrder>> | null = null;
  if (useOkxDemo) {
    const credentials = await decryptExchangeCredential(account.encryptedCredentialRef);
    entryOrder = await placeOkxDemoMarketOrder({ credentials, symbol: selected.symbol, side: "buy", notionalUsdt: notional, clientOrderId: `APE${Date.now().toString(36)}${crypto.randomUUID().slice(0, 7)}` });
    orderId = entryOrder.orderId;
    orderStatus = entryOrder.state === "filled" ? "filled" : "submitted";
    executionVenue = "okx_demo";
    if (entryOrder.filledQuantity > 0 && entryOrder.averagePrice > 0) {
      quantity = entryOrder.filledQuantity;
      entryValueUsdt = entryOrder.filledQuantity * entryOrder.averagePrice;
      entryFee = okxFeeInUsdt(entryOrder);
    } else entryFee = 0;
  }
  const decisionId = await insertDecision({ subscription, accountId: account.id, symbol: selected.symbol, strategyVersion: definition.version, status: orderStatus === "filled" ? "approved" : "executing", evidence: { ...runtimeEvidence, action: "enter", notional, quantity, executionVenue, exchangeOrder: entryOrder, todayPnl, openExposure }, riskApproved: true });
  const tradeId = crypto.randomUUID();
  await db.batch([
    db.insert(trades).values({ id: tradeId, exchangeAccountId: account.id, customerId: subscription.customerId, decisionId, strategyCode: subscription.strategyCode, communityStrategyId: null, exchangeOrderId: orderId, executionVenue, symbol: selected.symbol, side: "buy", origin: "platform", status: orderStatus, openedAt: now, quantity, entryValueUsdt, exitValueUsdt: 0, feesUsdt: entryFee, fundingUsdt: 0, realizedNetPnlUsdt: 0 }),
    db.update(platformStrategySubscriptions).set({ lastRiskCheckAt: now, riskCheckJson: JSON.stringify({ ...runtimeEvidence, lastCandleCloseBySymbol: nextLastCandles, result: orderStatus === "filled" ? "entered" : "awaiting_entry_fill", decisionId, tradeId }), updatedAt: now }).where(eq(platformStrategySubscriptions.id, subscription.id)),
    db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: null, action: useOkxDemo ? "platform_ai.okx_demo_entry.submitted" : "platform_ai.validation_position.opened", subjectType: "trade", subjectId: tradeId, afterJson: JSON.stringify({ decisionId, orderId, notional: entryValueUsdt, quantity, orderStatus, executionVenue, exchangeOrder: entryOrder }) }),
  ]);
  return { subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "entered", message: useOkxDemo ? "OKX 验证环境指令已提交并保存交易所回执" : "真实行情信号与硬风控通过，已建立可审计验证仓位", decisionId, tradeId };
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get("x-automation-key"), runtimeSetting("AUTOMATION_INTERNAL_SECRET"))) {
    return Response.json({ error: "自动运行密钥无效" }, { status: 401 });
  }
  if (!(await marketDataIsHealthy())) return Response.json({ error: "实时行情源健康检查失败，本轮未生成交易决策" }, { status: 503 });
  await ensureD1Schema();
  const limit = Math.min(500, Math.max(1, Number(runtimeSetting("AUTOMATION_MAX_SUBSCRIPTIONS_PER_RUN") || 100)));
  const subscriptions = await getDb().select().from(platformStrategySubscriptions).where(eq(platformStrategySubscriptions.status, "active")).limit(limit);
  const results: CycleResult[] = [];
  for (const subscription of subscriptions) {
    try {
      results.push(await processSubscription(subscription));
    } catch (error) {
      results.push({ subscriptionId: subscription.id, strategyCode: subscription.strategyCode, status: "failed", message: error instanceof Error ? error.message : "平台 AI 策略运行失败" });
    }
  }
  const counts = results.reduce<Record<string, number>>((output, result) => {
    output[result.status] = (output[result.status] || 0) + 1;
    return output;
  }, {});
  return Response.json({ engine: "platform-ai-deterministic-v1", environment: "validation", processed: results.length, counts, results, completedAt: new Date().toISOString() });
}
