import { requireCurrentAccessAssignmentAdmin, requireCurrentAccessViewer } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { appId } = await requireCurrentAccessViewer(request);
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT ura.*, r.code AS role_code, r.name AS role_name
      FROM user_role_assignments AS ura
      INNER JOIN roles AS r ON r.id = ura.role_id
      WHERE ura.application_id = $1
      ORDER BY ura.created_at DESC
      LIMIT 300
    `, [appId]);
    return Response.json({ assignments: result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      roleId: row.role_id,
      applicationId: row.application_id,
      status: row.status,
      roleCode: row.role_code,
      roleName: row.role_name,
      effectiveAt: row.effective_at instanceof Date ? row.effective_at.toISOString() : row.effective_at,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user, appId } = await requireCurrentAccessAssignmentAdmin(request);
    const body = await readResearchJson(request);
    const targetUserId = String(body.userId ?? "");
    const roleId = String(body.roleId ?? "");
    if (!targetUserId || !roleId) throw new ResearchApiError("VALIDATION_ERROR", "用户和角色为必填", 422, { fields: ["userId", "roleId"] });
    const pool = await getPostgresPool();
    const role = await pool.query<{ application_id: string }>("SELECT application_id FROM roles WHERE id = $1 AND application_id = $2 AND status = 'published' LIMIT 1", [roleId, appId]);
    if (!role.rows[0]) throw new ResearchApiError("NOT_FOUND", "角色不存在或未发布", 404);
    const sensitive = await pool.query<{ sensitive_count: string }>(`
      SELECT COUNT(*)::text AS sensitive_count
      FROM role_permissions AS rp
      INNER JOIN permission_definitions AS pd ON pd.key = rp.permission_key
      WHERE rp.role_id = $1 AND pd.sensitive = true
    `, [roleId]);
    if (Number(sensitive.rows[0]?.sensitive_count ?? 0) > 0) {
      throw new ResearchApiError("SENSITIVE_APPROVAL_REQUIRED", "包含敏感权限的角色必须先走双人审批", 409, { roleId });
    }
    const result = await pool.query(`
      INSERT INTO user_role_assignments (
        id, user_id, role_id, application_id, organization_id,
        expires_at, granted_by_user_id, reason
      )
      SELECT $1, u.id, $2, $3, u.organization_id, $4::timestamptz, $5, $6
      FROM users AS u
      WHERE u.id = $7
      RETURNING id, user_id, role_id, application_id, status, effective_at, expires_at
    `, [
      crypto.randomUUID(),
      roleId,
      role.rows[0].application_id,
      body.expiresAt ? String(body.expiresAt) : null,
      user.id,
      String(body.reason ?? "").slice(0, 500),
      targetUserId,
    ]);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "用户不存在", 404);
    return Response.json({ assignment: result.rows[0] }, { status: 201 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
