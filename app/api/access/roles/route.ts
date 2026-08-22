import { limitedText, parseAccessAppId, parseRolePermissions } from "@/lib/access-management";
import { requireCurrentAccessAdmin, requireCurrentAccessViewer } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { SENSITIVE_PERMISSION_KEYS } from "@/lib/rbac";
import { accessOrganizationResourcePredicate, scopeCanDelegate } from "@/lib/access-center-scope";

export async function GET(request: Request) {
  try {
    const { user, appId, scope, organizationIds } = await requireCurrentAccessViewer(request);
    const pool = await getPostgresPool();
    const resourceScope = accessOrganizationResourcePredicate({
      scope,
      actor: user,
      organizationIds,
      columns: ["r.created_organization_id", "r.applies_to_organization_id"],
      startIndex: 2,
    });
    const result = await pool.query(`
      SELECT r.*, COALESCE(
        jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope))
          FILTER (WHERE rp.id IS NOT NULL),
        '[]'::jsonb
      ) AS permissions
      FROM roles AS r
      LEFT JOIN role_permissions AS rp ON rp.role_id = r.id
      WHERE r.application_id = $1 AND ${resourceScope.clause}
      GROUP BY r.id
      ORDER BY r.code ASC
    `, [appId, ...resourceScope.values]);
    return Response.json({ roles: result.rows.filter((row) => (row.permissions as Array<{ scope: Parameters<typeof scopeCanDelegate>[1] }>).every((permission) => scopeCanDelegate(scope, permission.scope))).map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      status: row.status,
      isSystem: Boolean(row.is_system),
      createdOrganizationId: row.created_organization_id,
      appliesToOrganizationId: row.applies_to_organization_id,
      permissions: row.permissions,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user, appId, scope } = await requireCurrentAccessAdmin(request);
    if (scope !== "PLATFORM") throw new ResearchApiError("FORBIDDEN", "应用级角色变更需要平台范围授权", 403);
    const body = await readResearchJson(request);
    const applicationId = parseAccessAppId(body.applicationId);
    if (applicationId !== appId) throw new ResearchApiError("FORBIDDEN", "不能管理其他应用的角色", 403);
    const code = limitedText(body.code, "code", 80);
    const name = limitedText(body.name, "name", 120);
    const kind = String(body.kind ?? "custom");
    if (!["custom", "derived"].includes(kind)) throw new ResearchApiError("VALIDATION_ERROR", "角色类型无效", 422, { fields: ["kind"] });
    const permissions = parseRolePermissions(body.permissions, applicationId);
    if (permissions.some((permission) => SENSITIVE_PERMISSION_KEYS.has(permission.permissionKey))) {
      throw new ResearchApiError("SENSITIVE_APPROVAL_REQUIRED", "包含敏感权限的角色必须走双人审批", 409);
    }
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const roleId = crypto.randomUUID();
      await client.query(`
        INSERT INTO roles (id, application_id, code, name, kind, status, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5, 'draft', $6)
      `, [roleId, applicationId, code, name, kind, user.id]);
      for (const permission of permissions) {
        await client.query(`
          INSERT INTO role_permissions (id, role_id, permission_key, scope)
          VALUES ($1, $2, $3, $4)
        `, [crypto.randomUUID(), roleId, permission.permissionKey, permission.scope]);
      }
      await client.query("COMMIT");
      return Response.json({ role: { id: roleId, applicationId, code, name, kind, status: "draft" } }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
