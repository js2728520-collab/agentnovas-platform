import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  approvalRequests,
  auditLogs,
  communityStrategies,
} from "@/db/schema";
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

    if (!strategy) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (strategy.publicationMode === "self_use") return Response.json({ error: "自用策略不会进入策略广场，也无需提交平台审核" }, { status: 409 });
    if (strategy.validationLabel !== "STANDARD_VERIFIED") {
      return Response.json({ error: "只有通过标准/深度验证的策略版本才能提交策略广场审核" }, { status: 409 });
    }
    if (!["draft", "testing", "rejected"].includes(strategy.status)) {
      return Response.json({ error: "策略当前状态不能提交审核" }, { status: 409 });
    }
    const approvalId = crypto.randomUUID();
    const now = new Date().toISOString();
    const evidence = {
      version: strategy.version,
      authorUserId: me.id,
      submittedAt: now,
      reviewMode: "human_review",
    };

    await db.batch([
      db.update(communityStrategies)
        .set({ status: "submitted", submittedAt: now, rejectionReason: null, updatedAt: now })
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
        beforeJson: JSON.stringify({ status: strategy.status, version: strategy.version }),
        afterJson: JSON.stringify({ status: "submitted", approvalId, ...evidence }),
      }),
    ]);

    return Response.json({
      approvalId,
      status: "submitted",
      message: "已提交平台双人审核",
    });
  } catch (error) {
    return responseError(error);
  }
}
