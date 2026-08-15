import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, platformStrategySubscriptions } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { requireUser, responseError } from "@/lib/session";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const body = await request.json() as { action?: "pause" | "stop" };
    if (!body.action || !["pause", "stop"].includes(body.action)) return Response.json({ error: "操作类型无效" }, { status: 400 });
    const db = getDb();
    const subscription = (await db.select().from(platformStrategySubscriptions).where(and(
      eq(platformStrategySubscriptions.id, id),
      eq(platformStrategySubscriptions.customerId, me.id),
    )).limit(1))[0];
    if (!subscription) return Response.json({ error: "平台策略跟随关系不存在" }, { status: 404 });
    const now = new Date().toISOString();
    const status = body.action === "stop" ? "ended" : "paused";
    await db.batch([
      db.update(platformStrategySubscriptions).set({ status, endedAt: status === "ended" ? now : null, updatedAt: now }).where(eq(platformStrategySubscriptions.id, id)),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: `platform_strategy.follow.${status}`,
        subjectType: "platform_strategy_subscription",
        subjectId: id,
        afterJson: JSON.stringify({ strategyCode: subscription.strategyCode, status, at: now }),
      }),
    ]);
    return Response.json({ id, status, message: status === "ended" ? "平台 AI 策略跟随已停止" : "平台 AI 策略已暂停新开仓" });
  } catch (error) {
    return responseError(error);
  }
}
