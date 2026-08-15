import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  exchangeAccounts,
  memberships,
  platformDecisions,
  trades,
} from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";
import { getSpotPrice, marketDataIsHealthy, normalizeSpotSymbol } from "@/lib/market-data";
import { getExchangeOrderRoutingStatus } from "@/lib/exchange-order-routing";
import { membershipAccess } from "@/lib/membership-rules";

const allowedSymbols = new Set([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT", "DOTUSDT", "LTCUSDT",
  "BCHUSDT", "TONUSDT", "SUIUSDT", "APTUSDT", "NEARUSDT", "ARBUSDT",
  "OPUSDT", "UNIUSDT",
]);

export async function GET(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const db = getDb();
    const authored = await db.select({ id: communityStrategies.id }).from(communityStrategies).where(eq(communityStrategies.authorUserId, me.id));
    if (!authored.length) return Response.json({ orders: [] });
    const orders = await db.select().from(trades)
      .where(and(eq(trades.customerId, me.id), inArray(trades.communityStrategyId, authored.map((row) => row.id))))
      .orderBy(desc(trades.createdAt))
      .limit(2000);
    return Response.json({ orders });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (process.env.PLATFORM_EMERGENCY_STOP === "true") {
      return Response.json({ error: "平台处于紧急停止状态，当前仅允许平仓与撤单" }, { status: 503 });
    }
    const me = await requireUser(request, ["customer"]);
    const body = await request.json() as {
      exchangeAccountId?: string;
      symbol?: string;
      side?: "buy" | "sell";
      quantity?: number;
      communityStrategyId?: string;
      subscriptionId?: string;
    };
    if (!body.communityStrategyId || body.subscriptionId) {
      return Response.json({ error: "普通模拟下单和模拟跟单已关闭；这里只能测试你自己创建的策略" }, { status: 403 });
    }
    if (!body.exchangeAccountId || !body.symbol || !body.side || !body.quantity || body.quantity <= 0) {
      return Response.json({ error: "策略测试账户、方向和数量均为必填" }, { status: 400 });
    }
    if (!(["buy", "sell"] as const).includes(body.side)) return Response.json({ error: "交易方向无效" }, { status: 400 });
    const symbol = normalizeSpotSymbol(body.symbol);
    if (!allowedSymbols.has(symbol)) return Response.json({ error: "交易对不在允许的主流资产范围" }, { status: 400 });

    const db = getDb();
    const account = (await db.select().from(exchangeAccounts).where(and(
      eq(exchangeAccounts.id, body.exchangeAccountId),
      eq(exchangeAccounts.customerId, me.id),
    )).limit(1))[0];
    if (!account) return Response.json({ error: "交易账户不存在" }, { status: 404 });
    if (account.environment !== "demo") {
      const routing = getExchangeOrderRoutingStatus(account.exchange, account.environment);
      return Response.json({
        error: "实盘订单路由尚未开放；当前只允许保存凭证与检测权限，不会发送订单",
        code: routing.code || "EXCHANGE_LIVE_DISABLED",
        exchange: account.exchange,
        environment: account.environment,
        routing,
      }, { status: 409 });
    }
    if (account.status !== "active" || !account.canTrade) return Response.json({ error: "账户未通过权限检测或未开启交易权限" }, { status: 403 });
    const membership = (await db.select().from(memberships).where(and(
      eq(memberships.customerId, me.id),
      inArray(memberships.status, ["active", "grace"]),
    )).limit(1))[0];
    const now = new Date().toISOString();
    if (!membership || !membershipAccess(now, membership).newEntriesAllowed) {
      return Response.json({ error: "会员或免费体验已结束，当前只允许平仓" }, { status: 403 });
    }

    const strategy = (await db.select().from(communityStrategies).where(and(
      eq(communityStrategies.id, body.communityStrategyId),
      eq(communityStrategies.authorUserId, me.id),
    )).limit(1))[0];
    if (!strategy || !["draft", "testing", "rejected"].includes(strategy.status)) {
      return Response.json({ error: "该策略不属于当前用户或当前状态不可进行作者模拟测试" }, { status: 409 });
    }

    if (strategy) {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(strategy.symbolsJson || "[]") as unknown;
      } catch {
        return Response.json({ error: "策略交易对配置损坏，风控已拒绝下单" }, { status: 409 });
      }
      const strategySymbols = Array.isArray(parsed) ? parsed.map((item) => normalizeSpotSymbol(String(item))) : [];
      if (!strategySymbols.includes(symbol)) return Response.json({ error: "交易对不属于该策略当前版本的允许范围" }, { status: 409 });
    }

    if (!(await marketDataIsHealthy())) return Response.json({ error: "行情数据暂不可用，风控已禁止开仓" }, { status: 503 });
    let quote: Awaited<ReturnType<typeof getSpotPrice>>;
    try {
      quote = await getSpotPrice(symbol);
    } catch {
      return Response.json({ error: "无法取得可信实时价格，风控已拒绝下单" }, { status: 503 });
    }
    const open = await db.select().from(trades).where(and(eq(trades.customerId, me.id), isNull(trades.closedAt))).limit(100);
    const today = new Date().toISOString().slice(0, 10);
    const allTrades = await db.select().from(trades).where(eq(trades.customerId, me.id));
    const todayPnl = allTrades.filter((row) => (row.closedAt || row.updatedAt || "").startsWith(today)).reduce((sum, row) => sum + row.realizedNetPnlUsdt, 0);
    const dailyLossLimitUsdt = Number(process.env.MAX_DAILY_LOSS_USDT || 3_000);
    if (todayPnl <= -Math.abs(dailyLossLimitUsdt)) return Response.json({ error: "已触发单日亏损限制，系统禁止继续开仓" }, { status: 403 });
    const value = body.quantity * quote.price;
    const simulatedEquityUsdt = Number(process.env.SIMULATED_EQUITY_USDT || 10_000);
    const positionLimit = simulatedEquityUsdt;
    const strategyOpenValue = open
      .filter((row) => row.communityStrategyId === strategy.id)
      .reduce((sum, row) => sum + row.entryValueUsdt, 0);
    if (strategyOpenValue + value > positionLimit) {
      return Response.json({ error: `触发模拟仓位上限 ${positionLimit.toFixed(2)} USDT` }, { status: 403 });
    }
    const duplicate = open.find((row) => row.symbol === symbol && row.side === body.side && Date.now() - new Date(row.createdAt || row.openedAt || 0).getTime() < 5_000);
    if (duplicate) return Response.json({ error: "检测到重复下单，请稍后再试" }, { status: 409 });

    const decisionId = crypto.randomUUID();
    const tradeId = crypto.randomUUID();
    const orderId = `SIM-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const strategyCode = `community:${strategy.id}`;
    const strategyVersion = `v${strategy.version}`;
    const riskChecks = ["author_strategy_only", "demo_only", "membership_access", "account_active", "trade_permission", "market_freshness", "daily_loss_limit", "position_limit", "duplicate_order_guard"];
    const evidence = { source: "author_strategy_simulation", hardRiskChecks: riskChecks, strategyId: strategy.id, quote, simulatedEquityUsdt, positionLimit, dailyLossLimitUsdt, submittedAt: now };
    await db.batch([
      db.insert(platformDecisions).values({ id: decisionId, customerId: me.id, exchangeAccountId: account.id, strategyCode, strategyVersion, symbol, status: "approved", evidenceJson: JSON.stringify(evidence) }),
      db.insert(trades).values({ id: tradeId, exchangeAccountId: account.id, customerId: me.id, decisionId, strategyCode: strategy ? strategyCode : null, communityStrategyId: strategy?.id || null, exchangeOrderId: orderId, symbol, side: body.side, origin: "platform", status: "filled", openedAt: now, quantity: body.quantity, entryValueUsdt: value, exitValueUsdt: 0, feesUsdt: Number((value * 0.001).toFixed(8)), fundingUsdt: 0, realizedNetPnlUsdt: 0 }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "author_strategy_simulation.created", subjectType: "trade", subjectId: tradeId, afterJson: JSON.stringify({ decisionId, orderId, symbol, side: body.side, quantity: body.quantity, price: quote.price, priceProvider: quote.provider, priceObservedAt: quote.observedAt, strategyId: strategy.id, strategyVersion, hardRiskChecks: riskChecks }) }),
    ]);
    return Response.json({ orderId, tradeId, decisionId, strategyId: strategy.id, strategyVersion, status: "filled", mode: "author-strategy-test", fillPrice: quote.price, priceProvider: quote.provider, message: "策略测试订单已按后台行情记录，不会发送到交易所" }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
