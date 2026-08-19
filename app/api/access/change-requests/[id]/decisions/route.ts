import { ACCESS_ADMIN_PERMISSIONS } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const decision = String(body.decision ?? "");
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("VALIDATION_ERROR", "审批决定无效", 422, { fields: ["decision"] });
    const pool = await getPostgresPool();
    const change = await pool.query<{ requested_by_user_id: string; status: string }>("SELECT requested_by_user_id, status FROM access_change_requests WHERE id = $1 LIMIT 1", [id]);
    if (!change.rows[0]) throw new ResearchApiError("NOT_FOUND", "权限变更申请不存在", 404);
    if (change.rows[0].requested_by_user_id === user.id) throw new ResearchApiError("FORBIDDEN", "申请人不能审批自己的权限变更", 403);
    if (change.rows[0].status !== "pending") throw new ResearchApiError("CONFLICT", "权限变更申请已处理", 409);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO access_change_decisions (id, request_id, reviewer_user_id, decision, note)
        VALUES ($1, $2, $3, $4, $5)
      `, [crypto.randomUUID(), id, user.id, decision, String(body.note ?? "").slice(0, 500)]);
      await client.query(`
        UPDATE access_change_requests
        SET status = $1, completed_at = now()
        WHERE id = $2 AND status = 'pending'
      `, [decision === "approve" ? "approved" : "rejected", id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, status: decision === "approve" ? "approved" : "rejected" });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

