import { ACCESS_ADMIN_PERMISSIONS, parseAccessAppId } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const changeTypes = new Set(["role_create", "role_update", "role_assign", "role_revoke", "template_publish"]);

export async function POST(request: Request) {
  try {
    const { user } = await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const body = await readResearchJson(request);
    const applicationId = parseAccessAppId(body.applicationId);
    const changeType = String(body.changeType ?? "");
    if (!changeTypes.has(changeType)) throw new ResearchApiError("VALIDATION_ERROR", "权限变更类型无效", 422, { fields: ["changeType"] });
    const pool = await getPostgresPool();
    const result = await pool.query(`
      INSERT INTO access_change_requests (
        id, application_id, target_user_id, target_role_id,
        change_type, before_json, after_json, requested_by_user_id, reason
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      RETURNING id, application_id, change_type, status, requested_at
    `, [
      crypto.randomUUID(),
      applicationId,
      body.targetUserId ? String(body.targetUserId) : null,
      body.targetRoleId ? String(body.targetRoleId) : null,
      changeType,
      JSON.stringify(body.before ?? {}),
      JSON.stringify(body.after ?? {}),
      user.id,
      String(body.reason ?? "").slice(0, 500),
    ]);
    return Response.json({ changeRequest: result.rows[0] }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

