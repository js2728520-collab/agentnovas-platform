import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.action_approve");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const decision = String(body.decision ?? "");
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("VALIDATION_ERROR", "审批决定无效", 422, { fields: ["decision"] });
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!note) throw new ResearchApiError("VALIDATION_ERROR", "必须填写审批意见", 422, { fields: ["note"] });
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "d", "d.user_id", 2, organizationIds);
      const action = await client.query<{ requested_by_user_id: string; status: string }>(`
        SELECT ar.requested_by_user_id, ar.status
        FROM deposit_action_requests AS ar
        INNER JOIN deposit_orders AS d ON d.id = ar.deposit_order_id
        WHERE ar.id = $1 AND ${scoped.clause}
        FOR UPDATE OF ar
      `, [id, ...scoped.values]);
      if (!action.rows[0]) throw new ResearchApiError("NOT_FOUND", "人工操作申请不存在", 404);
      if (action.rows[0].requested_by_user_id === user.id) throw new ResearchApiError("FORBIDDEN", "申请人不能审批自己的资金操作", 403);
      if (action.rows[0].status !== "pending") throw new ResearchApiError("CONFLICT", "该申请已处理", 409);
      await client.query(`
        INSERT INTO deposit_action_decisions (id, request_id, reviewer_user_id, decision, note)
        VALUES ($1, $2, $3, $4, $5)
      `, [crypto.randomUUID(), id, user.id, decision, note]);
      const updated = await client.query(`
        UPDATE deposit_action_requests
        SET status = $1, completed_at = now()
        WHERE id = $2 AND status = 'pending'
        RETURNING id
      `, [decision === "approve" ? "approved" : "rejected", id]);
      if (!updated.rows[0]) throw new ResearchApiError("CONFLICT", "该申请已被其他审批人处理", 409);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, status: decision === "approve" ? "approved" : "rejected" });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
