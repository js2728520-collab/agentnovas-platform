import { ACCESS_ADMIN_PERMISSIONS } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const { id } = await context.params;
    const pool = await getPostgresPool();
    const result = await pool.query(`
      UPDATE roles
      SET status = 'published', updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'disabled')
      RETURNING id, application_id, code, name, kind, status
    `, [id]);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "角色不存在或状态不可发布", 404);
    return Response.json({ role: result.rows[0] });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

