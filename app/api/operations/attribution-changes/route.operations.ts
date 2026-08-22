import { requireAccessPermission } from "@/lib/access-control";
import { submitAttributionChange } from "@/lib/attribution-change-service";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { commercialCustomerScopePredicate, operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { cursorPage } from "@/lib/commercial-public-contract";
import { maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.attributions.manage");
    const { url, limit, cursor } = commercialListInput(request);
    const values: unknown[] = [];
    const where: string[] = [];
    const status = url.searchParams.get("status")?.trim() ?? "";
    if (status) {
      if (!["pending", "approved", "rejected", "cancelled"].includes(status)) throw new ResearchApiError("STATUS_INVALID", "客户归属调整状态无效", 422);
      values.push(status); where.push(`change.status=$${values.length}`);
    }
    const customerId = url.searchParams.get("customerId")?.trim() ?? "";
    if (customerId) { values.push(customerId); where.push(`change.customer_id=$${values.length}`); }
    if (cursor) { values.push(cursor.createdAt, cursor.id); where.push(`(change.requested_at,change.id)<($${values.length - 1}::timestamptz,$${values.length})`); }
    const scoped = commercialCustomerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "scope_attribution_change", "change.customer_id", values.length + 1, organizationIds);
    values.push(...scoped.values); where.push(scoped.clause); values.push(limit + 1);
    const result = await (await getPostgresPool()).query(`
      SELECT change.*,customer.email AS customer_email,requester.email AS requester_email,reviewer.email AS reviewer_email
        FROM customer_attribution_change_requests change
        JOIN users customer ON customer.id=change.customer_id
        JOIN users requester ON requester.id=change.requested_by_user_id
        LEFT JOIN users reviewer ON reviewer.id=change.decided_by_user_id
       WHERE ${where.join(" AND ")}
       ORDER BY change.requested_at DESC,change.id DESC LIMIT $${values.length}
    `, values);
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > limit && last ? encodeCommercialCursor({ createdAt: new Date(last.requested_at).toISOString(), id: last.id }) : null;
    return Response.json(cursorPage(rows.map((row) => ({
      id: row.id, requestNo: row.request_no, customerId: row.customer_id, customerEmail: maskOperationsEmail(row.customer_email),
      branchId: row.branch_id, previousAssignment: row.previous_assignment_json, proposedAssignment: row.proposed_assignment_json,
      effectiveAt: new Date(row.effective_at).toISOString(), reason: row.reason, status: row.status,
      requestedBy: { userId: row.requested_by_user_id, email: maskOperationsEmail(row.requester_email) }, requestedAt: new Date(row.requested_at).toISOString(),
      decidedBy: row.decided_by_user_id ? { userId: row.decided_by_user_id, email: maskOperationsEmail(row.reviewer_email) } : null,
      decisionNote: row.decision_note, decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
      canReview: row.status === "pending" && row.requested_by_user_id !== user.id,
    })), limit, nextCursor), { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}

export async function POST(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.attributions.manage");
    const body = await readResearchJson(request, 8_192);
    const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
    const managerId = typeof body.managerId === "string" ? body.managerId.trim() : "";
    if (!customerId || !managerId) throw new ResearchApiError("ATTRIBUTION_TARGET_REQUIRED", "必须选择客户和目标经理", 422);
    return Response.json(await submitAttributionChange(await getPostgresPool(), {
      actorUserId: user.id, customerId, managerId,
      supervisorId: typeof body.supervisorId === "string" ? body.supervisorId : null,
      employeeId: typeof body.employeeId === "string" ? body.employeeId : null,
      effectiveAt: typeof body.effectiveAt === "string" ? body.effectiveAt : new Date().toISOString(),
      reason: typeof body.reason === "string" ? body.reason : "",
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      authorize: operationsCustomerScopeAuthorization(scope, { userId: user.id, organizationId: user.organizationId }, organizationIds),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
