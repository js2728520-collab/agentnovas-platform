import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  approvalDecisions,
  approvalRequests,
  auditLogs,
  collectionCases,
  communityStrategies,
  customerAttributions,
  payoutProfiles,
  revenueEvents,
  settlements,
  users,
} from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { canAccessOrganization } from "@/lib/operations-access";
import { responseError } from "@/lib/session";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.approvals.decide");
    const { id } = await params;
    const body = await request.json() as { decision?: "approve" | "reject"; note?: string };
    if (!body.decision) return Response.json({ error: "缺少审批决定" }, { status: 400 });
    const db = getDb();
    const approval = (await db.select().from(approvalRequests).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending"))).limit(1))[0];
    if (!approval) return Response.json({ error: "审批单不存在或已结束" }, { status: 404 });
    if (approval.requestedBy === user.id) return Response.json({ error: "申请人不能审批自己的申请" }, { status: 403 });

    const isStrategyReview = approval.type === "strategy_listing";
    if (!approval.branchId && scope !== "PLATFORM") return Response.json({ error: "无权审批平台级申请" }, { status: 403 });
    if (approval.branchId && !canAccessOrganization(scope, { userId: user.id, organizationId: user.organizationId }, approval.branchId, organizationIds)) {
      return Response.json({ error: "不能审批授权范围外的申请" }, { status: 403 });
    }

    try {
      await db.insert(approvalDecisions).values({ id: crypto.randomUUID(), requestId: id, reviewerId: user.id, decision: body.decision, note: body.note || "" });
    } catch {
      return Response.json({ error: "你已经处理过此审批单" }, { status: 409 });
    }
    const decisions = await db.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, id));
    const now = new Date().toISOString();
    if (body.decision === "reject") {
      const operations = [
        db.update(approvalRequests).set({ status: "rejected", completedAt: now }).where(eq(approvalRequests.id, id)),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: `${approval.type}.rejected`, subjectType: approval.subjectType, subjectId: approval.subjectId, afterJson: JSON.stringify({ note: body.note || "未填写原因" }) }),
      ];
      if (isStrategyReview) operations.push(db.update(communityStrategies).set({ status: "rejected", rejectionReason: body.note || "平台审核未通过", updatedAt: now }).where(eq(communityStrategies.id, approval.subjectId)) as never);
      await db.batch(operations as never);
      return Response.json({ status: "rejected" });
    }
    const approvals = decisions.filter((row) => row.decision === "approve");
    if (approvals.length < 2) return Response.json({ status: "pending", approvals: approvals.length, required: 2 });

    if (isStrategyReview) {
      const payload = JSON.parse(approval.payloadJson) as { version?: number };
      const strategy = (await db.select().from(communityStrategies).where(eq(communityStrategies.id, approval.subjectId)).limit(1))[0];
      if (!strategy || strategy.status !== "submitted" || strategy.version !== Number(payload.version)) {
        return Response.json({ error: "策略版本已变化或不再处于待审核状态，请重新提交" }, { status: 409 });
      }
      await db.batch([
        db.update(communityStrategies).set({ status: "published", approvedAt: now, publishedAt: now, rejectionReason: null, updatedAt: now }).where(eq(communityStrategies.id, approval.subjectId)),
        db.update(approvalRequests).set({ status: "approved", completedAt: now }).where(eq(approvalRequests.id, id)),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: "strategy_listing.approved", subjectType: "community_strategy", subjectId: approval.subjectId, afterJson: JSON.stringify({ version: payload.version, reviewers: approvals.map((row) => row.reviewerId), publishedAt: now }) }),
      ]);
      return Response.json({ status: "approved", effective: true, published: true });
    }

    if (approval.type === "customer_attribution" || approval.type === "customer_transfer") {
      const payload = JSON.parse(approval.payloadJson) as { branchId: string; managerId: string; supervisorId?: string | null; employeeId?: string | null; effectiveAt: string; reason: string };
      await db.update(customerAttributions).set({ status: "active", source: approval.type === "customer_transfer" ? "manual_transfer" : undefined, branchId: payload.branchId, managerId: payload.managerId, supervisorId: payload.supervisorId || null, employeeId: payload.employeeId || null, effectiveAt: payload.effectiveAt, reason: payload.reason, approvalId: id, updatedAt: now }).where(eq(customerAttributions.id, approval.subjectId));
    }
    if (approval.type === "settlement_payment") await db.update(settlements).set({ status: "approved", updatedAt: now }).where(eq(settlements.id, approval.subjectId));
    if (approval.type === "revenue_adjustment") {
      const payload = JSON.parse(approval.payloadJson) as { customerId: string; sourceId: string; amountUsdt: number };
      await db.insert(revenueEvents).values({ id: crypto.randomUUID(), customerId: payload.customerId, type: "adjustment", sourceId: payload.sourceId, amountUsdt: payload.amountUsdt, confirmedAt: now, attributionStatus: "manual_adjustment", ruleVersion: "v1", status: "confirmed" });
    }
    if (approval.type === "payout_profile_change") await db.update(payoutProfiles).set({ status: "active", updatedAt: now }).where(eq(payoutProfiles.id, approval.subjectId));
    if (approval.type === "collection_paid_confirmation") await db.update(collectionCases).set({ status: "paid", newEntriesAllowed: true, paidConfirmedBy: user.id, paidConfirmedAt: now, updatedAt: now }).where(eq(collectionCases.id, approval.subjectId));
    if (approval.type === "reporting_line_change") {
      const payload = JSON.parse(approval.payloadJson) as { newReportsToUserId: string; newRole?: string };
      const role = payload.newRole as "branch_admin" | "manager" | "supervisor" | "employee" | undefined;
      if (role) await db.update(users).set({ reportsToUserId: payload.newReportsToUserId, role, updatedAt: now }).where(eq(users.id, approval.subjectId));
      else await db.update(users).set({ reportsToUserId: payload.newReportsToUserId, updatedAt: now }).where(eq(users.id, approval.subjectId));
    }
    await db.batch([
      db.update(approvalRequests).set({ status: "approved", completedAt: now }).where(eq(approvalRequests.id, id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: `${approval.type}.approved`, subjectType: approval.subjectType, subjectId: approval.subjectId, afterJson: approval.payloadJson }),
    ]);
    return Response.json({ status: "approved", effective: true });
  } catch (error) {
    return responseError(error);
  }
}
