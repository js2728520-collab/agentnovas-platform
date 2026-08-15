import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  exchangeAccounts,
  memberships,
  platformFollowPolicies,
  strategySubscriptions,
} from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { membershipAccess } from "@/lib/membership-rules";
import { checkExchangeForStrategy } from "@/lib/exchange-capabilities";
import { evaluateFollowPolicy } from "@/lib/follow-policy";
import { requireUser, responseError } from "@/lib/session";

type LifecycleAction = "pause" | "resume" | "stop";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const body = await request.json() as { action?: LifecycleAction };
    if (!body.action || !["pause", "resume", "stop"].includes(body.action)) {
      return Response.json({ error: "操作类型无效" }, { status: 400 });
    }

    const db = getDb();
    const subscription = (await db.select().from(strategySubscriptions).where(and(
      eq(strategySubscriptions.id, id),
      eq(strategySubscriptions.customerId, me.id),
    )).limit(1))[0];
    if (!subscription) return Response.json({ error: "跟随关系不存在" }, { status: 404 });

    const now = new Date().toISOString();
    let nextStatus: "active" | "paused" | "ended";
    let riskCheck: Record<string, unknown> | undefined;

    if (body.action === "pause") {
      if (subscription.status !== "active") return Response.json({ error: "只有运行中的策略可以暂停" }, { status: 409 });
      nextStatus = "paused";
    } else if (body.action === "stop") {
      if (subscription.status === "ended") return Response.json({ id, status: "ended", message: "跟随已停止" });
      nextStatus = "ended";
    } else {
      return Response.json({ error: "实盘跟单尚未开放；当前不能恢复模拟跟单" }, { status: 403 });
      if (subscription.status !== "paused") return Response.json({ error: "只有已暂停的策略可以恢复" }, { status: 409 });
      if (!subscription.exchangeAccountId) return Response.json({ error: "未绑定模拟交易账户，无法恢复" }, { status: 409 });

      const [strategy, account, membership, policy] = await Promise.all([
        db.select().from(communityStrategies).where(and(
          eq(communityStrategies.id, subscription.strategyId),
          eq(communityStrategies.status, "published"),
        )).limit(1).then((rows) => rows[0]),
        db.select().from(exchangeAccounts).where(and(
          eq(exchangeAccounts.id, subscription.exchangeAccountId!),
          eq(exchangeAccounts.customerId, me.id),
        )).limit(1).then((rows) => rows[0]),
        db.select().from(memberships).where(and(
          eq(memberships.customerId, me.id),
          inArray(memberships.status, ["active", "grace"]),
        )).limit(1).then((rows) => rows[0]),
        db.select({ allowFollowWithoutWithdrawal: platformFollowPolicies.allowFollowWithoutWithdrawal }).from(platformFollowPolicies).where(eq(platformFollowPolicies.id, "default")).limit(1).then((rows) => rows[0]),
      ]);
      if (!strategy) return Response.json({ error: "策略已下架或暂停，无法恢复跟随" }, { status: 409 });
      if (!account) return Response.json({ error: "模拟交易账户不存在，无法恢复跟随" }, { status: 409 });
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
      if (account.environment !== "demo" || account.status !== "active" || !account.canRead || !account.canTrade) {
        return Response.json({ error: "模拟交易账户未通过读取与交易权限复检" }, { status: 409 });
      }
      const followPolicy = evaluateFollowPolicy({
        allowFollowWithoutWithdrawal: Boolean(policy?.allowFollowWithoutWithdrawal),
        withdrawalAuthorized: Boolean(account.withdrawalAuthorized),
        publicationMode: "marketplace",
      });
      if (!followPolicy.allowed) return Response.json({ error: "当前模式下，恢复平台 AI 或策略广场策略前必须在 API 账户中开启提现授权", code: "WITHDRAWAL_AUTHORIZATION_REQUIRED" }, { status: 403 });
      if (!membership) return Response.json({ error: "会员或免费体验权限不可用" }, { status: 403 });
      const access = membershipAccess(now, membership);
      if (!access.newEntriesAllowed) return Response.json({ error: "会员或免费体验已结束，当前只允许平仓" }, { status: 403 });
      const active = await db.select({ id: strategySubscriptions.id }).from(strategySubscriptions).where(and(
        eq(strategySubscriptions.customerId, me.id),
        eq(strategySubscriptions.status, "active"),
      ));
      if (active.length >= membership.maxActiveStrategies) {
        return Response.json({ error: `当前会员最多同时运行 ${membership.maxActiveStrategies} 个策略` }, { status: 409 });
      }
      riskCheck = {
        membershipStatus: access.status,
        membershipLimit: membership.maxActiveStrategies,
        exchangeAccountStatus: account.status,
        environment: account.environment,
        market: exchangeCheck.requiredMarket,
        exchangeCapabilities: exchangeCheck.capability,
        canRead: account.canRead,
        canTrade: account.canTrade,
        withdrawalAuthorized: account.withdrawalAuthorized,
        manualCollectionRequired: followPolicy.manualCollectionRequired,
        checkedAt: now,
      };
      nextStatus = "active";
    }

    const update = {
      status: nextStatus,
      endedAt: nextStatus === "ended" ? now : null,
      lastRiskCheckAt: riskCheck ? now : subscription.lastRiskCheckAt,
      riskCheckJson: riskCheck ? JSON.stringify(riskCheck) : subscription.riskCheckJson,
      updatedAt: now,
    } as const;
    await db.batch([
      db.update(strategySubscriptions).set(update).where(eq(strategySubscriptions.id, id)),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: `strategy.follow.${body.action}`,
        subjectType: "strategy_subscription",
        subjectId: id,
        beforeJson: JSON.stringify({ status: subscription.status }),
        afterJson: JSON.stringify({ status: nextStatus, riskCheck: riskCheck || null }),
      }),
    ]);

    const message = nextStatus === "active"
      ? "账户、会员和策略状态复检通过，模拟跟随已恢复"
      : nextStatus === "paused"
        ? "已暂停新开仓；已有仓位仍可接受风控、减仓和平仓"
        : "已停止跟随；已有仓位不会被强制删除，仍可平仓";
    return Response.json({ id, status: nextStatus, message });
  } catch (error) {
    return responseError(error);
  }
}
