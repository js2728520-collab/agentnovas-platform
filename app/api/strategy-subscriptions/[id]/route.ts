import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  strategySubscriptions,
} from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";

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

    const message = nextStatus === "paused"
        ? "已暂停新开仓；已有仓位仍可接受风控、减仓和平仓"
        : "已停止跟随；已有仓位不会被强制删除，仍可平仓";
    return Response.json({ id, status: nextStatus, message });
  } catch (error) {
    return responseError(error);
  }
}
