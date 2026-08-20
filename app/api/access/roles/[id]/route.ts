import { limitedText } from "@/lib/access-management";
import { requireCurrentAccessAdmin } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { appId } = await requireCurrentAccessAdmin(request);
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const name = limitedText(body.name, "name", 120);
    const pool = await getPostgresPool();
    const result = await pool.query(`
      UPDATE roles
      SET name = $1, updated_at = now()
      WHERE id = $2 AND application_id = $3 AND is_system = false
      RETURNING id, application_id, code, name, kind, status
    `, [name, id, appId]);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "角色不存在或系统角色不可直接修改", 404);
    return Response.json({ role: result.rows[0] });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
