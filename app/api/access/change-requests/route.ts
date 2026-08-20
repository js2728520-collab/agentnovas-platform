import { ACCESS_ADMIN_PERMISSIONS } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { parseAccessChangeRequest } from "@/lib/access-change-requests";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    const { user } = await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const body = await readResearchJson(request);
    const change = parseAccessChangeRequest(body);
    const requiredManagePermission = change.applicationId === "operations" ? "ops.roles.manage"
      : change.applicationId === "maintenance" ? "maint.roles.manage" : null;
    if (!requiredManagePermission) {
      return Response.json({ error: { code: "FORBIDDEN", message: "客户端应用不支持角色管理变更", details: {} } }, { status: 403 });
    }
    await requireAnyAccessPermission(request, [requiredManagePermission]);
    const pool = await getPostgresPool();
    // Validate references and application ownership before creating an actionable request.
    if (change.changeType === "role_assign") {
      const result = await pool.query(`
        SELECT u.id AS user_id, r.id AS role_id
        FROM users u CROSS JOIN roles r
        WHERE u.id = $1 AND r.id = $2 AND r.application_id = $3 AND r.status = 'published'
      `, [change.targetUserId, change.targetRoleId, change.applicationId]);
      if (!result.rows[0]) throw new Error("ACCESS_REFERENCE_NOT_FOUND");
    } else if (change.changeType === "role_update") {
      const result = await pool.query("SELECT id FROM roles WHERE id = $1 AND application_id = $2 AND is_system = false", [change.targetRoleId, change.applicationId]);
      if (!result.rows[0]) throw new Error("ACCESS_REFERENCE_NOT_FOUND");
    } else if (change.changeType === "role_revoke") {
      const result = await pool.query(`
        SELECT ura.id FROM user_role_assignments ura
        JOIN roles r ON r.id = ura.role_id
        WHERE ura.id = $1 AND ura.user_id = $2 AND r.id = $3
          AND ura.application_id = $4 AND ura.status = 'active'
      `, [change.after.assignmentId, change.targetUserId, change.targetRoleId, change.applicationId]);
      if (!result.rows[0]) throw new Error("ACCESS_REFERENCE_NOT_FOUND");
    }
    const result = await pool.query(`
      INSERT INTO access_change_requests
        (id, application_id, target_user_id, target_role_id, change_type, before_json, after_json, requested_by_user_id, reason)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      RETURNING id, application_id, change_type, status, requested_at
    `, [crypto.randomUUID(), change.applicationId, change.targetUserId, change.targetRoleId,
      change.changeType, JSON.stringify(change.before), JSON.stringify(change.after), user.id,
      String(body.reason ?? "").slice(0, 500)]);
    return Response.json({ changeRequest: result.rows[0] }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ACCESS_REFERENCE_NOT_FOUND") {
      return Response.json({ error: { code: "NOT_FOUND", message: "目标不存在、应用不匹配或状态不允许", details: {} } }, { status: 404 });
    }
    return researchErrorResponse(error);
  }
}
