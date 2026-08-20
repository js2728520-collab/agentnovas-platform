import { requireAccessPermission } from "@/lib/access-control";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import {
  membershipOrderDto,
  paymentEvidenceDto,
} from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, scope } = await requireAccessPermission(
        request,
        "ops.membership_orders.view",
      ),
      { id } = await params;
    const values: unknown[] = [id],
      scoped = commercialCustomerScopePredicate(
        scope,
        { userId: user.id, organizationId: user.organizationId },
        "scope_order",
        "o.user_id",
        2,
      );
    values.push(...scoped.values);
    const pool = await getPostgresPool(),
      result = await pool.query(
        `SELECT o.*,p.plan_code,p.version FROM commercial_membership_orders o JOIN commercial_plan_versions p ON p.id=o.plan_version_id WHERE o.id=$1 AND ${scoped.clause}`,
        values,
      ),
      order = result.rows[0];
    if (!order)
      throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
    const [evidence, decisions] = await Promise.all([
      pool.query(
        `SELECT id,membership_order_id,performance_statement_id,evidence_kind,provider_label,reference_masked,reference_fingerprint_version,amount::text,currency,occurred_at,note,recorded_by_user_id,status,reviewed_by_user_id,reviewed_at,created_at FROM commercial_payment_evidence WHERE membership_order_id=$1 ORDER BY created_at`,
        [id],
      ),
      pool.query(
        `SELECT id,reviewer_user_id,decision,payment_evidence_id,created_at FROM commercial_membership_order_decisions WHERE order_id=$1 ORDER BY created_at`,
        [id],
      ),
    ]);
    return Response.json(
      {
        order: membershipOrderDto(order),
        evidence: evidence.rows.map(paymentEvidenceDto),
        decisions: decisions.rows.map((row) => ({
          id: row.id,
          reviewerUserId: row.reviewer_user_id,
          decision: row.decision,
          paymentEvidenceId: row.payment_evidence_id,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error);
  }
}
