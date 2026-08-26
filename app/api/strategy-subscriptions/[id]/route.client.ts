import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  strategySubscriptions,
} from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { pauseFollow, resumeFollow, stopFollow } from "@/packages/domain/src/strategy-follow-lifecycle";
import { isCustomerTradingEmergencyStopped } from "@/lib/trading-emergency";

type LifecycleAction = "pause" | "resume" | "stop";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureDatabaseSchema();
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
    if (body.action === "resume" && await isCustomerTradingEmergencyStopped(me.id)) {
      return Response.json({ error: "当前所属范围处于紧急停止状态，暂不能恢复策略" }, { status: 503 });
    }

    const now = new Date().toISOString();
    const riskCheck: Record<string, unknown> | undefined = undefined;

    // 客户对自己的跟随行使的是 PRD 6.6 四方里最弱的那一方：可以暂停与终止自己的跟随，
    // 但解除不了风控阻断。判定交给状态机，路由不自己写 if。
    let transition;
    if (body.action === "pause") {
      transition = pauseFollow(subscription.status, "customer");
    } else if (body.action === "stop") {
      if (subscription.status === "stopped") return Response.json({ id, status: "stopped", message: "跟随已停止" });
      transition = stopFollow(subscription.status, "customer");
    } else if (body.action === "resume") {
      // 实盘跟随仍然关闭；Paper 跟随可以恢复（T4.4）。
      if (subscription.runMode === "live") {
        return Response.json({ error: "实盘跟单尚未开放；当前不能恢复实盘跟随" }, { status: 403 });
      }
      transition = resumeFollow(subscription.status, {
        pausedBy: subscription.pausedBy, authority: "customer",
      });
    } else {
      return Response.json({ error: "不支持的跟随操作" }, { status: 422 });
    }

    if (!transition.allowed) {
      // 风控阻断与「状态不对」是两回事，报错要分开：前者要告诉客户去找运营，
      // 后者只是操作时机不对。
      const riskBlocked = transition.reason === "insufficient_authority";
      return Response.json({
        error: riskBlocked
          ? "该跟随由风控阻断，需要运营风控解除后才能恢复"
          : "跟随当前状态不允许该操作",
        code: riskBlocked ? "FOLLOW_RISK_BLOCKED" : "FOLLOW_TRANSITION_INVALID",
        status: subscription.status,
        pausedBy: subscription.pausedBy ?? null,
      }, { status: 409 });
    }
    const nextStatus = transition.nextState;

    const update = {
      status: nextStatus,
      pausedBy: transition.pausedBy,
      pausedAt: transition.pausedBy ? now : null,
      endedAt: nextStatus === "stopped" ? now : null,
      endedBy: nextStatus === "stopped" ? ("customer" as const) : null,
      endedReason: nextStatus === "stopped" ? ("customer_stopped" as const) : null,
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

    const message = nextStatus === "paused"
        ? "已暂停新开仓；已有仓位仍可接受风控、减仓和平仓"
        : "已停止跟随；已有仓位不会被强制删除，仍可平仓";
    return Response.json({ id, status: nextStatus, message });
  } catch (error) {
    return responseError(error);
  }
}
