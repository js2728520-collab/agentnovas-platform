import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  approvalRequests,
  auditLogs,
  communityStrategies,
} from "@/db/schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireUser, responseError } from "@/lib/session";
import { evaluateAndRecordAdmission } from "@/lib/strategy-admission-repository";
import { applyStrategyListingTransition } from "@/packages/domain/src/strategy-listing-state";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const shareToMarketplace = body.shareToMarketplace === true;
    const db = getDb();
    const strategy = (await db
      .select()
      .from(communityStrategies)
      .where(and(
        eq(communityStrategies.id, id),
        eq(communityStrategies.authorUserId, me.id),
      ))
      .limit(1))[0];

    if (!strategy) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (strategy.publicationMode === "self_use" && !shareToMarketplace) return Response.json({ error: "自用策略需要先确认分享到策略广场" }, { status: 409 });
    if (strategy.validationLabel !== "STANDARD_VERIFIED") {
      return Response.json({ error: "只有通过标准/深度验证的策略版本才能提交策略广场审核" }, { status: 409 });
    }
    // 状态迁移由状态机判定，不再是路由里的一句 includes。
    const transition = applyStrategyListingTransition(strategy.status, "submit");
    if (!transition.allowed) {
      return Response.json({
        error: "策略当前状态不能提交审核",
        currentStatus: strategy.status,
        allowedTransitions: transition.allowed === false ? transition.allowedTransitions : [],
      }, { status: 409 });
    }

    // P-05 准入门槛。PRD 6.5「不得用口头结论替代」：判定是确定性的，逐项结果落库，
    // 未达标的返回具体哪几条不达标，而不是一句「不符合要求」。
    const admission = await evaluateAndRecordAdmission(await getPostgresPool(), {
      strategyId: id,
      strategyVersion: strategy.version,
      riskLevel: strategy.riskLevel,
      validationLabel: strategy.validationLabel,
    });
    if (!admission.result.meetsThresholds) {
      return Response.json({
        error: "策略未达到广场准入门槛",
        code: "STRATEGY_ADMISSION_NOT_MET",
        failedChecks: admission.result.failedCheckIds,
        checks: admission.result.checks,
      }, { status: 409 });
    }

    const approvalId = crypto.randomUUID();
    const now = new Date().toISOString();
    const evidence = {
      version: strategy.version,
      authorUserId: me.id,
      submittedAt: now,
      reviewMode: "human_review",
      // 审核人要能复核这次投稿当初按的是哪套门槛、依据哪份回测。
      admissionEvaluationId: admission.evaluationId,
      validationId: admission.validationId,
      admissionThresholdsVersionId: admission.configurationVersionId,
    };

    await db.batch([
      db.update(communityStrategies)
        .set({
          status: transition.nextState,
          publicationMode: "marketplace",
          submittedAt: now,
          rejectionReason: null,
          updatedAt: now,
        })
        .where(eq(communityStrategies.id, id)),
      db.insert(approvalRequests).values({
        id: approvalId,
        type: "strategy_listing",
        subjectType: "community_strategy",
        subjectId: id,
        payloadJson: JSON.stringify(evidence),
        requestedBy: me.id,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "strategy.review.submitted",
        subjectType: "community_strategy",
        subjectId: id,
        beforeJson: JSON.stringify({ status: strategy.status, publicationMode: strategy.publicationMode, version: strategy.version }),
        afterJson: JSON.stringify({ status: "submitted", publicationMode: "marketplace", approvalId, ...evidence }),
      }),
    ]);

    return Response.json({
      approvalId,
      status: "submitted",
      message: shareToMarketplace ? "已分享到策略广场并提交平台双人审核" : "已提交平台双人审核",
    });
  } catch (error) {
    return responseError(error);
  }
}
