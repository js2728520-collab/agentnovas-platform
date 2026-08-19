import { ACCESS_ADMIN_PERMISSIONS } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const { id } = await context.params;
    const pool = await getPostgresPool();
    const result = await pool.query(`
      UPDATE user_role_assignments
      SET status = 'revoked', revoked_by_user_id = $1, revoked_at = now(), updated_at = now()
      WHERE id = $2 AND status = 'active'
      RETURNING id, user_id, application_id, status, revoked_at
    `, [user.id, id]);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "角色分配不存在或已失效", 404);
    return Response.json({ assignment: result.rows[0] });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

