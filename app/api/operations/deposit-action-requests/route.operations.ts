import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate, maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const statuses = new Set(["pending", "approved", "rejected", "cancelled"]);

export async function GET(request: Request) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.action_approve");
    const canRevealPii = Boolean(access.permissions["ops.deposits.pii_reveal"]);
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "pending";
    if (status && !statuses.has(status)) {
      throw new ResearchApiError("VALIDATION_ERROR", "审批状态无效", 422, { fields: ["status"] });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "d", "d.user_id", 2, organizationIds);
    const params: unknown[] = [status, ...scoped.values, limit];
    const limitIndex = params.length;
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string;
      deposit_order_id: string;
      platform_order_no: string;
      action: string;
      status: string;
      reason: string;
      requested_by_user_id: string;
      requester_email: string | null;
      customer_email: string | null;
      currency: string;
      actual_amount: string | null;
      requested_at: Date;
      completed_at: Date | null;
    }>(`
      SELECT ar.id, ar.deposit_order_id, d.platform_order_no, ar.action, ar.status,
             ar.reason, ar.requested_by_user_id, requester.email AS requester_email,
             customer.email AS customer_email, d.currency, d.actual_amount::text,
             ar.requested_at, ar.completed_at
      FROM deposit_action_requests AS ar
      INNER JOIN deposit_orders AS d ON d.id = ar.deposit_order_id
      INNER JOIN users AS customer ON customer.id = d.user_id
      INNER JOIN users AS requester ON requester.id = ar.requested_by_user_id
      WHERE ar.status = $1 AND ${scoped.clause}
      ORDER BY ar.requested_at DESC
      LIMIT $${limitIndex}
    `, params);
    return Response.json({
      actionRequests: result.rows.map((row) => ({
        id: row.id,
        depositOrderId: row.deposit_order_id,
        platformOrderNo: row.platform_order_no,
        action: row.action,
        status: row.status,
        reason: row.reason,
        requestedBy: {
          userId: row.requested_by_user_id,
          email: canRevealPii ? row.requester_email : maskOperationsEmail(row.requester_email),
        },
        customerEmail: canRevealPii ? row.customer_email : maskOperationsEmail(row.customer_email),
        currency: row.currency,
        actualAmount: row.actual_amount,
        requestedAt: row.requested_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
        canReview: row.requested_by_user_id !== user.id && row.status === "pending",
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
