import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.reconciliation.run");
    const body = await readResearchJson(request);
    const customerId = String(body.customerId ?? "");
    const sourceId = String(body.sourceId ?? "");
    const amountUsdt = Number(body.amountUsdt);
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    const evidence = String(body.evidence ?? "").trim().slice(0, 2000);
    if (!customerId || !sourceId || !Number.isFinite(amountUsdt) || amountUsdt === 0 || !reason) throw new ResearchApiError("VALIDATION_ERROR", "客户、关联订单、非零金额和原因均为必填", 422);
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "ca", "ca.customer_id", 2, organizationIds);
    const pool = await getPostgresPool();
    const visible = await pool.query(`SELECT ca.customer_id FROM customer_attributions AS ca WHERE ca.customer_id = $1 AND ${scoped.clause} LIMIT 1`, [customerId, ...scoped.values]);
    if (!visible.rows[0]) throw new ResearchApiError("NOT_FOUND", "客户不存在或不在当前数据范围", 404);
    const requestId = crypto.randomUUID();
    await pool.query(`INSERT INTO approval_requests (id, type, branch_id, subject_type, subject_id, payload_json, requested_by) VALUES ($1, 'revenue_adjustment', $2, 'customer', $3, $4, $5)`, [requestId, user.organizationId, customerId, JSON.stringify({ sourceId, amountUsdt, reason, evidence }), user.id]);
    return Response.json({ requestId, status: "pending", requiredApprovals: 2, ledgerChanged: false }, { status: 201 });
  } catch (error) { return researchErrorResponse(error, request); }
}
