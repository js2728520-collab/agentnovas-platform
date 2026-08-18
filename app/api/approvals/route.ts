import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalDecisions, approvalRequests } from "@/db/schema";
import { branchApprovalRoles } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request);
    const isStrategyReviewer = ["hq_admin", "auditor"].includes(actor.role);
    const isBranchReviewer = (branchApprovalRoles as readonly string[]).includes(actor.role);
    if (!isStrategyReviewer && !isBranchReviewer) return Response.json({ error: "无权查看审批中心" }, { status: 403 });
    const db = getDb();
    const allPending = await db.select().from(approvalRequests).where(eq(approvalRequests.status, "pending")).orderBy(desc(approvalRequests.requestedAt)).limit(300);
    const requests = allPending.filter((row) => {
      if (row.type === "strategy_listing") return isStrategyReviewer;
      return isBranchReviewer && Boolean(actor.organizationId) && row.branchId === actor.organizationId;
    });
    const decisions = await db.select().from(approvalDecisions);
    return Response.json({ requests: requests.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson), approvals: decisions.filter((decision) => decision.requestId === row.id && decision.decision === "approve").length, required: 2 })) });
  } catch (error) {
    return responseError(error);
  }
}
