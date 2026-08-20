import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalDecisions, approvalRequests } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { canAccessOrganization } from "@/lib/operations-access";
import { responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.approvals.view");
    const db = getDb();
    const allPending = await db.select().from(approvalRequests).where(eq(approvalRequests.status, "pending")).orderBy(desc(approvalRequests.requestedAt)).limit(300);
    const requests = allPending.filter((row) => {
      if (!row.branchId) return scope === "PLATFORM";
      return canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, row.branchId, organizationIds);
    });
    const decisions = await db.select().from(approvalDecisions);
    return Response.json({ requests: requests.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson), approvals: decisions.filter((decision) => decision.requestId === row.id && decision.decision === "approve").length, required: 2 })) });
  } catch (error) {
    return responseError(error);
  }
}
