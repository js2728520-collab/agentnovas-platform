import { requireAccessPermission } from "@/lib/access-control";
import { organizationScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.approvals.view");
    const values: unknown[] = [];
    const scoped = organizationScopePredicate(scope, { userId: actor.id, organizationId: actor.organizationId }, "approval.branch_id", 1, organizationIds);
    values.push(...scoped.values, actor.id);
    const actorIndex = values.length;
    const result = await (await getPostgresPool()).query(`
      SELECT approval.id,approval.type,approval.subject_id,approval.payload_json,
             approval.requested_by,approval.requested_at,
             count(decision.id) FILTER (WHERE decision.decision='approve')::int AS approvals,
             NOT EXISTS(
               SELECT 1 FROM approval_decisions own
               WHERE own.request_id=approval.id AND own.reviewer_id=$${actorIndex}
             ) AND approval.requested_by<>$${actorIndex} AS can_review
        FROM approval_requests approval
        LEFT JOIN approval_decisions decision ON decision.request_id=approval.id
       WHERE approval.status='pending'
         AND approval.type='reporting_line_change'
         AND (${scoped.clause})
       GROUP BY approval.id
       ORDER BY approval.requested_at DESC,approval.id DESC
       LIMIT 100
    `, values);
    return Response.json({
      requests: result.rows.map((row) => {
        const payload = JSON.parse(row.payload_json || "{}") as Record<string, unknown>;
        return {
          id: row.id,
          type: row.type,
          subjectId: row.subject_id,
          requestedBy: row.requested_by,
          requestedAt: row.requested_at,
          reason: typeof payload.reason === "string" ? payload.reason : "",
          newReportsToUserId: typeof payload.newReportsToUserId === "string" ? payload.newReportsToUserId : null,
          approvals: Number(row.approvals),
          required: 1,
          canReview: Boolean(row.can_review),
        };
      }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
