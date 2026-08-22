import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const allowedActions = new Set([
  "APPROVE_CREDIT",
  "REJECT_DEPOSIT",
  "MANUAL_RECORD",
  "FREEZE_FUNDS",
  "UNFREEZE_FUNDS",
  "REQUEST_RETURN",
  "CONFIRM_RETURN",
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.action_request");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const action = String(body.action ?? "");
    if (!allowedActions.has(action)) throw new ResearchApiError("VALIDATION_ERROR", "人工操作类型无效", 422, { fields: ["action"] });
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写人工操作原因", 422, { fields: ["reason"] });
    const pool = await getPostgresPool();
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "d", "d.user_id", 2, organizationIds);
    const existing = await pool.query(`SELECT d.id FROM deposit_orders AS d WHERE d.id = $1 AND ${scoped.clause} LIMIT 1`, [id, ...scoped.values]);
    if (!existing.rows[0]) throw new ResearchApiError("NOT_FOUND", "充值订单不存在", 404);
    const requestId = crypto.randomUUID();
    const inserted = await pool.query<{
      id: string;
      action: string;
      status: string;
      requested_at: Date;
    }>(`
      INSERT INTO deposit_action_requests (
        id, deposit_order_id, action, payload_json, requested_by_user_id, reason
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      RETURNING id, action, status, requested_at
    `, [
      requestId,
      id,
      action,
      JSON.stringify(body.payload ?? {}),
      user.id,
      reason,
    ]);
    return Response.json({
      actionRequest: {
        id: inserted.rows[0].id,
        action: inserted.rows[0].action,
        status: inserted.rows[0].status,
        requestedAt: inserted.rows[0].requested_at.toISOString(),
      },
    }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
