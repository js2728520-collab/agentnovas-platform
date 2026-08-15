import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  exchangeAccounts,
  memberships,
  platformFollowPolicies,
  platformStrategySubscriptions,
  strategySubscriptions,
} from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { evaluateFollowPolicy } from "@/lib/follow-policy";
import { membershipAccess } from "@/lib/membership-rules";
import { isPlatformStrategyCode, PLATFORM_AI_STRATEGIES } from "@/lib/platform-ai-strategies";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const { code } = await params;
    if (!isPlatformStrategyCode(code)) return Response.json({ error: "平台 AI 策略不存在" }, { status: 404 });
    const definition = PLATFORM_AI_STRATEGIES[code];
    const body = await request.json() as {
      exchangeAccountId?: string;
      capitalPct?: number;
      stopLossPct?: number;
      riskConsent?: boolean;
    };
    if (!body.riskConsent) return Response.json({ error: "请先确认策略风险说明" }, { status: 400 });
    if (!body.exchangeAccountId) return Response.json({ error: "请选择已通过检测的验证账户" }, { status: 400 });
    const capitalPct = Number(body.capitalPct);
    const stopLossPct = Number(body.stopLossPct);
    if (!Number.isFinite(capitalPct) || capitalPct < 1 || capitalPct > definition.maxCapitalPct) {
      return Response.json({ error: `${definition.name} 的资金使用上限为 ${definition.maxCapitalPct}%` }, { status: 400 });
    }
    if (!Number.isFinite(stopLossPct) || stopLossPct < 0.5 || stopLossPct > definition.stopLossPct) {
      return Response.json({ error: `${definition.name} 的账户止损不得高于 ${definition.stopLossPct}%` }, { status: 400 });
    }

    const db = getDb();
    const [account, membership, policy, activeCommunity, activePlatform] = await Promise.all([
      db.select().from(exchangeAccounts).where(and(
        eq(exchangeAccounts.id, body.exchangeAccountId),
        eq(exchangeAccounts.customerId, me.id),
      )).limit(1).then((rows) => rows[0]),
      db.select().from(memberships).where(and(
        eq(memberships.customerId, me.id),
        inArray(memberships.status, ["active", "grace"]),
      )).limit(1).then((rows) => rows[0]),
      db.select({ allowFollowWithoutWithdrawal: platformFollowPolicies.allowFollowWithoutWithdrawal })
        .from(platformFollowPolicies).where(eq(platformFollowPolicies.id, "default")).limit(1).then((rows) => rows[0]),
      db.select({ id: strategySubscriptions.id }).from(strategySubscriptions).where(and(
        eq(strategySubscriptions.customerId, me.id),
        eq(strategySubscriptions.status, "active"),
      )),
      db.select({ id: platformStrategySubscriptions.id }).from(platformStrategySubscriptions).where(and(
        eq(platformStrategySubscriptions.customerId, me.id),
        eq(platformStrategySubscriptions.status, "active"),
      )),
    ]);
    if (!account) return Response.json({ error: "所选交易账户不存在" }, { status: 404 });
    if (account.environment !== "demo") return Response.json({ error: "当前仅开放验证环境，实盘路由仍由服务端硬性关闭" }, { status: 403 });
    if (account.status !== "active" || !account.canRead || !account.canTrade) {
      return Response.json({ error: "账户尚未通过连接、读取和交易权限检测" }, { status: 409 });
    }
    const followPolicy = evaluateFollowPolicy({
      allowFollowWithoutWithdrawal: Boolean(policy?.allowFollowWithoutWithdrawal),
      withdrawalAuthorized: Boolean(account.withdrawalAuthorized),
      publicationMode: "marketplace",
    });
    if (!followPolicy.allowed) {
      return Response.json({
        code: "WITHDRAWAL_AUTHORIZATION_REQUIRED",
        error: "当前模式下，跟随平台 AI 策略前必须在 API 账户中开启结算授权",
      }, { status: 403 });
    }
    if (!membership) return Response.json({ error: "会员权限不可用，请先开通会员" }, { status: 403 });
    const now = new Date().toISOString();
    const access = membershipAccess(now, membership);
    if (!access.newEntriesAllowed) return Response.json({ error: "会员权限已进入只平仓状态，不能新增策略" }, { status: 403 });

    const existing = (await db.select().from(platformStrategySubscriptions).where(and(
      eq(platformStrategySubscriptions.strategyCode, code),
      eq(platformStrategySubscriptions.customerId, me.id),
    )).limit(1))[0];
    if (!existing && activeCommunity.length + activePlatform.length >= membership.maxActiveStrategies) {
      return Response.json({ error: `当前会员最多同时运行 ${membership.maxActiveStrategies} 个策略` }, { status: 409 });
    }
    if (existing?.status === "active") return Response.json({ subscriptionId: existing.id, status: "active", message: "该平台 AI 策略已在运行" });

    const subscriptionId = existing?.id || crypto.randomUUID();
    const riskCheck = {
      engine: "platform-ai-v1",
      strategyCode: code,
      strategyVersion: definition.version,
      membershipStatus: access.status,
      accountEnvironment: account.environment,
      accountStatus: account.status,
      canRead: account.canRead,
      canTrade: account.canTrade,
      withdrawalAuthorized: account.withdrawalAuthorized,
      manualCollectionRequired: followPolicy.manualCollectionRequired,
      capitalPct,
      stopLossPct,
      hardMaximumCapitalPct: definition.maxCapitalPct,
      leverage: 1,
      checkedAt: now,
    };
    if (existing) {
      await db.update(platformStrategySubscriptions).set({
        exchangeAccountId: account.id,
        capitalPct,
        stopLossPct,
        status: "active",
        riskConsentAt: now,
        lastRiskCheckAt: now,
        riskCheckJson: JSON.stringify(riskCheck),
        startedAt: existing.startedAt || now,
        endedAt: null,
        updatedAt: now,
      }).where(eq(platformStrategySubscriptions.id, existing.id));
    } else {
      await db.insert(platformStrategySubscriptions).values({
        id: subscriptionId,
        strategyCode: code,
        customerId: me.id,
        exchangeAccountId: account.id,
        capitalPct,
        stopLossPct,
        status: "active",
        riskConsentAt: now,
        lastRiskCheckAt: now,
        riskCheckJson: JSON.stringify(riskCheck),
        startedAt: now,
      });
    }
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: me.id,
      action: "platform_strategy.follow.activated",
      subjectType: "platform_strategy_subscription",
      subjectId: subscriptionId,
      afterJson: JSON.stringify(riskCheck),
    });
    return Response.json({
      subscriptionId,
      status: "active",
      strategy: definition,
      manualCollectionRequired: followPolicy.manualCollectionRequired,
      message: "平台 AI 策略已激活，将从下一根完整K线开始生成可审计决策",
    }, { status: existing ? 200 : 201 });
  } catch (error) {
    return responseError(error);
  }
}
