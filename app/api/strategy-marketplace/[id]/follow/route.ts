import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, communityStrategies, exchangeAccounts, memberships, strategySubscriptions } from "@/db/schema";
import { membershipAccess } from "@/lib/membership-rules";
import { checkExchangeForStrategy } from "@/lib/exchange-capabilities";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const body = await request.json() as { exchangeAccountId?: string; capitalPct?: number; stopLossPct?: number; executionMode?: "proportional" | "fixed_risk"; riskConsent?: boolean };
    const capitalPct = Number(body.capitalPct);
    const stopLossPct = Number(body.stopLossPct);
    if (!body.riskConsent) return Response.json({ error: "请先确认策略风险披露" }, { status: 400 });
    if (!body.exchangeAccountId) return Response.json({ error: "请选择已连接的模拟交易账户" }, { status: 400 });
    if (!Number.isFinite(capitalPct) || capitalPct < 5 || capitalPct > 50) return Response.json({ error: "资金使用上限必须在 5% 至 50% 之间" }, { status: 400 });
    if (!Number.isFinite(stopLossPct) || stopLossPct < 3 || stopLossPct > 20) return Response.json({ error: "策略止损线必须在 3% 至 20% 之间" }, { status: 400 });
    const db = getDb();
    const strategy = (await db.select().from(communityStrategies).where(and(eq(communityStrategies.id, id), eq(communityStrategies.status, "published"))).limit(1))[0];
    if (!strategy) return Response.json({ error: "策略未上架或已暂停" }, { status: 404 });
    if (strategy.authorUserId === me.id) return Response.json({ error: "不能跟随自己发布的策略" }, { status: 409 });
    const account = (await db.select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, body.exchangeAccountId), eq(exchangeAccounts.customerId, me.id))).limit(1))[0];
    if (!account) return Response.json({ error: "所选交易账户不存在" }, { status: 404 });
    const exchangeCheck = checkExchangeForStrategy(account.exchange, strategy as unknown as Record<string, unknown>);
    if (!exchangeCheck.ok) {
      return Response.json({
        code: "EXCHANGE_MARKET_UNSUPPORTED",
        error: exchangeCheck.reason,
        exchange: account.exchange,
        requiredMarket: exchangeCheck.requiredMarket,
        capabilities: exchangeCheck.capability,
      }, { status: 409 });
    }
    if (account.environment !== "demo") return Response.json({ error: "第一阶段仅允许模拟盘跟随，实盘将在闭环验收后开放" }, { status: 403 });
    if (account.status !== "active" || !account.canRead || !account.canTrade) return Response.json({ error: "交易账户尚未通过读取和交易权限检测" }, { status: 409 });
    const membership = (await db.select().from(memberships).where(and(eq(memberships.customerId, me.id), inArray(memberships.status, ["active", "grace"]))).limit(1))[0];
    if (!membership) return Response.json({ error: "会员或免费体验权限不可用，请先开通会员" }, { status: 403 });
    const now = new Date().toISOString();
    const access = membershipAccess(now, membership);
    if (!access.newEntriesAllowed) return Response.json({ error: "会员或免费体验已结束，当前只允许平仓" }, { status: 403 });
    const active = await db.select().from(strategySubscriptions).where(and(eq(strategySubscriptions.customerId, me.id), eq(strategySubscriptions.status, "active")));
    if (active.length >= membership.maxActiveStrategies) return Response.json({ error: `当前会员最多同时运行 ${membership.maxActiveStrategies} 个策略` }, { status: 409 });
    const existing = (await db.select().from(strategySubscriptions).where(and(eq(strategySubscriptions.strategyId, id), eq(strategySubscriptions.customerId, me.id))).limit(1))[0];
    if (existing?.status === "active") return Response.json({ subscriptionId: existing.id, status: existing.status, message: "该策略已经在跟随中" });
    const riskCheck = { membershipStatus: access.status, membershipLimit: membership.maxActiveStrategies, exchangeAccountStatus: account.status, environment: account.environment, market: exchangeCheck.requiredMarket, exchangeCapabilities: exchangeCheck.capability, canRead: account.canRead, canTrade: account.canTrade, checkedAt: now };
    const subscriptionId = existing?.id || crypto.randomUUID();
    if (existing) await db.update(strategySubscriptions).set({ exchangeAccountId: account.id, capitalPct, stopLossPct, executionMode: body.executionMode || "proportional", status: "active", riskConsentAt: now, lastRiskCheckAt: now, riskCheckJson: JSON.stringify(riskCheck), startedAt: existing.startedAt || now, endedAt: null, updatedAt: now }).where(eq(strategySubscriptions.id, existing.id));
    else await db.insert(strategySubscriptions).values({ id: subscriptionId, strategyId: id, customerId: me.id, exchangeAccountId: account.id, capitalPct, stopLossPct, executionMode: body.executionMode || "proportional", status: "active", riskConsentAt: now, lastRiskCheckAt: now, riskCheckJson: JSON.stringify(riskCheck), startedAt: now });
    await db.batch([
      db.update(communityStrategies).set({ lastFollowedAt: now, updatedAt: now }).where(eq(communityStrategies.id, id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "strategy.follow.activated", subjectType: "strategy_subscription", subjectId: subscriptionId, afterJson: JSON.stringify({ strategyId: id, exchangeAccountId: account.id, capitalPct, stopLossPct, executionMode: body.executionMode || "proportional", riskCheck }) }),
    ]);
    return Response.json({ subscriptionId, status: "active", message: "账户和会员风控检查已通过，模拟跟随已激活" }, { status: existing ? 200 : 201 });
  } catch (error) {
    return responseError(error);
  }
}
