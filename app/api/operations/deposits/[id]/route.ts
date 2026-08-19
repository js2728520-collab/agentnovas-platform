import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope } = await requireAccessPermission(request, "ops.deposits.view");
    const { id } = await context.params;
    const pool = await getPostgresPool();
    const params: unknown[] = [id];
    const where = ["d.id = $1"];
    if (scope !== "PLATFORM") {
      params.push(user.organizationId);
      where.push(`d.branch_id = $${params.length}`);
    }
    const result = await pool.query(`
      SELECT d.*, u.email, u.phone, u.nickname
      FROM deposit_orders AS d
      INNER JOIN users AS u ON u.id = d.user_id
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `, params);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "充值订单不存在", 404);
    return Response.json({ deposit: result.rows[0] }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
