import { requireCurrentAccessAssignmentAdmin, requireCurrentAccessViewer } from "@/lib/access-control";
import { accessPageCursor, accessUserScopePredicate, parseAccessPageCursor, scopeCanDelegate } from "@/lib/access-center-scope";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { appId, user, scope, organizationIds } = await requireCurrentAccessViewer(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
    const cursor = parseAccessPageCursor(url.searchParams.get("cursor"));
    const values: unknown[] = [appId];
    const scopePredicate = accessUserScopePredicate({
      scope,
      actor: { id: user.id, organizationId: user.organizationId },
      organizationIds,
      userAlias: "target_user",
      startIndex: values.length + 1,
    });
    values.push(...scopePredicate.values);
    const cursorClause = cursor
      ? `(ura.created_at, ura.id) < ($${values.push(cursor.createdAt)}::timestamptz, $${values.push(cursor.id)})`
      : "TRUE";
    const limitIndex = values.push(limit + 1);
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT ura.*, r.code AS role_code, r.name AS role_name,
             target_user.organization_id AS target_organization_id,
             target_user.reports_to_user_id AS target_reports_to_user_id
      FROM user_role_assignments AS ura
      INNER JOIN roles AS r ON r.id = ura.role_id
      INNER JOIN users AS target_user ON target_user.id = ura.user_id
      WHERE ura.application_id = $1
        AND (${scopePredicate.clause})
        AND ${cursorClause}
      ORDER BY ura.created_at DESC, ura.id DESC
      LIMIT $${limitIndex}
    `, values);
    const page = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? page.at(-1) : null;
    return Response.json({ assignments: page.map((row) => ({
      id: row.id,
      userId: row.user_id,
      roleId: row.role_id,
      applicationId: row.application_id,
      status: row.status,
      roleCode: row.role_code,
      roleName: row.role_name,
      organizationId: row.organization_id,
      organizationIds: row.scope_organization_ids_json,
      effectiveAt: row.effective_at instanceof Date ? row.effective_at.toISOString() : row.effective_at,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    })), nextCursor: next ? accessPageCursor({
      createdAt: next.created_at instanceof Date ? next.created_at.toISOString() : next.created_at,
      id: next.id,
    }) : null }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user, appId, scope, organizationIds } = await requireCurrentAccessAssignmentAdmin(request);
    const body = await readResearchJson(request);
    const targetUserId = String(body.userId ?? "");
    const roleId = String(body.roleId ?? "");
    if (!targetUserId || !roleId) throw new ResearchApiError("VALIDATION_ERROR", "用户和角色为必填", 422, { fields: ["userId", "roleId"] });
    const pool = await getPostgresPool();
    const scopePredicate = accessUserScopePredicate({
      scope,
      actor: { id: user.id, organizationId: user.organizationId },
      organizationIds,
      userAlias: "target_user",
      startIndex: 2,
    });
    const target = await pool.query(`
      SELECT target_user.id, target_user.organization_id
      FROM users AS target_user
      WHERE target_user.id = $1 AND (${scopePredicate.clause})
      LIMIT 1
    `, [targetUserId, ...scopePredicate.values]);
    if (!target.rows[0]) throw new ResearchApiError("FORBIDDEN", "不能为授权范围外的用户分配角色", 403);
    const role = await pool.query<{ application_id: string }>("SELECT application_id FROM roles WHERE id = $1 AND application_id = $2 AND status = 'published' LIMIT 1", [roleId, appId]);
    if (!role.rows[0]) throw new ResearchApiError("NOT_FOUND", "角色不存在或未发布", 404);
    const roleScopes = await pool.query<{ scope: Parameters<typeof scopeCanDelegate>[1] }>("SELECT scope FROM role_permissions WHERE role_id = $1", [roleId]);
    if (roleScopes.rows.some((permission) => !scopeCanDelegate(scope, permission.scope))) {
      throw new ResearchApiError("SCOPE_ESCALATION", "不能分配数据范围大于自身授权的角色", 403);
    }
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
      WITH inserted AS (
        INSERT INTO user_role_assignments (
          id, user_id, role_id, application_id, organization_id,
          scope_organization_ids_json, expires_at, granted_by_user_id, reason
        )
        SELECT $1, u.id, $2, $3, u.organization_id,
               CASE WHEN u.organization_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(u.organization_id) END,
               $4::timestamptz, $5, $6
        FROM users AS u
        WHERE u.id = $7
        RETURNING id, user_id, role_id, application_id, status, effective_at, expires_at
      ), cleared_tombstone AS (
        DELETE FROM rbac_revocation_tombstones
        WHERE user_id = $7 AND application_id = $3
      )
      SELECT * FROM inserted
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
