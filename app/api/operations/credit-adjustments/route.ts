import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { commercialCustomerScopePredicate, operationsCustomerScopeAuthorization } from "@/lib/commercial-operations-scope";
import { cursorPage } from "@/lib/commercial-public-contract";
import { submitCreditAdjustment } from "@/lib/credit-adjustment-service";
import { maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.credits.view");
    const { url, limit, cursor } = commercialListInput(request);
    const values: unknown[] = [];
    const where: string[] = [];
    const status = url.searchParams.get("status")?.trim() ?? "";
    if (status) {
      if (!["pending", "approved", "rejected"].includes(status)) throw new ResearchApiError("STATUS_INVALID", "Credits 调整状态无效", 422);
      values.push(status); where.push(`request.status=$${values.length}`);
    }
    const customerId = url.searchParams.get("customerId")?.trim() ?? "";
    if (customerId) { values.push(customerId); where.push(`request.user_id=$${values.length}`); }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(`(request.requested_at,request.id)<($${values.length - 1}::timestamptz,$${values.length})`);
    }
    const scoped = commercialCustomerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "scope_credit_adjustment", "request.user_id", values.length + 1, organizationIds);
    values.push(...scoped.values); where.push(scoped.clause); values.push(limit + 1);
    const result = await (await getPostgresPool()).query(`
      SELECT request.id,request.request_no,request.user_id,customer.email AS customer_email,
             request.amount_delta::text,request.reason,request.evidence_reference,request.status,
             request.requested_by_user_id,requester.email AS requester_email,request.requested_at,
             request.decided_by_user_id,reviewer.email AS reviewer_email,request.decision_note,request.decided_at
        FROM ai_credit_adjustment_requests request
        JOIN users customer ON customer.id=request.user_id
        JOIN users requester ON requester.id=request.requested_by_user_id
        LEFT JOIN users reviewer ON reviewer.id=request.decided_by_user_id
       WHERE ${where.join(" AND ")}
       ORDER BY request.requested_at DESC,request.id DESC
       LIMIT $${values.length}
    `, values);
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > limit && last ? encodeCommercialCursor({ createdAt: new Date(last.requested_at).toISOString(), id: last.id }) : null;
    return Response.json(cursorPage(rows.map((row) => ({
      id: row.id, requestNo: row.request_no, customerId: row.user_id, customerEmail: maskOperationsEmail(row.customer_email),
      amountDelta: row.amount_delta, reason: row.reason, evidenceReference: row.evidence_reference, status: row.status,
      requestedBy: { userId: row.requested_by_user_id, email: maskOperationsEmail(row.requester_email) },
      requestedAt: new Date(row.requested_at).toISOString(),
      decidedBy: row.decided_by_user_id ? { userId: row.decided_by_user_id, email: maskOperationsEmail(row.reviewer_email) } : null,
      decisionNote: row.decision_note, decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
      canReview: row.status === "pending" && row.requested_by_user_id !== user.id,
    })), limit, nextCursor), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.credits.adjust");
    const body = await readResearchJson(request, 8_192);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
    if (!customerId) throw new ResearchApiError("CUSTOMER_ID_REQUIRED", "必须选择客户", 422);
    return Response.json(await submitCreditAdjustment(await getPostgresPool(), {
      actorUserId: user.id,
      customerId,
      amountDelta: typeof body.amountDelta === "string" || typeof body.amountDelta === "number" ? String(body.amountDelta) : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      evidenceReference: typeof body.evidenceReference === "string" ? body.evidenceReference : "",
      idempotencyKey,
      requestId,
      authorize: operationsCustomerScopeAuthorization(scope, { userId: user.id, organizationId: user.organizationId }, organizationIds),
    }), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
