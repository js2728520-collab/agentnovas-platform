import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  strategyValidations as strategyBacktestReports,
} from "@/db/schema";
import { runHistoricalBacktest } from "@/lib/backtest-engine";
import { requireUser, responseError } from "@/lib/session";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const strategy = (await db
      .select()
      .from(communityStrategies)
      .where(and(
        eq(communityStrategies.id, id),
        eq(communityStrategies.authorUserId, me.id),
      ))
      .limit(1))[0];

    if (!strategy || !["draft", "testing", "rejected"].includes(strategy.status)) {
      return Response.json({ error: "策略不存在或当前状态不可回测" }, { status: 409 });
    }

    const result = await runHistoricalBacktest(
      JSON.parse(strategy.specificationJson || "{}") as Record<string, unknown>,
    );
    const reportId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 复用已有历史数据表保存回测报告，但报告不构成提交或审核门槛。
    await db.batch([
      db.insert(strategyBacktestReports).values({
        id: reportId,
        strategyId: id,
        strategyVersion: strategy.version,
        kind: "backtest",
        status: "completed",
        source: "platform_engine",
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        sampleSize: result.sampleSize,
        netReturnPct: result.netReturnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        winRatePct: result.winRatePct,
        evidenceRef: result.evidenceRef,
        metricsJson: JSON.stringify(result),
        completedAt: now,
      }),
      db.update(communityStrategies)
        .set({ status: "testing", updatedAt: now })
        .where(eq(communityStrategies.id, id)),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "strategy.backtest.completed",
        subjectType: "community_strategy",
        subjectId: id,
        afterJson: JSON.stringify({
          reportId,
          source: "platform_engine",
          evidenceRef: result.evidenceRef,
          warnings: result.warnings,
        }),
      }),
    ]);

    return Response.json({
      reportId,
      result,
      message: result.warnings.length
        ? `历史回测已完成：${result.warnings.join("；")}`
        : "历史回测已完成，报告已保存",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
