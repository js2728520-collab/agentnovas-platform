import { limitedText, parseAccessAppId, parseRolePermissions } from "@/lib/access-management";
import { requireCurrentAccessAdmin, requireCurrentAccessViewer } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { SENSITIVE_PERMISSION_KEYS } from "@/lib/rbac";
import { accessOrganizationResourcePredicate } from "@/lib/access-center-scope";

export async function GET(request: Request) {
  try {
    const { user, appId, scope, organizationIds } = await requireCurrentAccessViewer(request);
    const pool = await getPostgresPool();
    const resourceScope = accessOrganizationResourcePredicate({
      scope,
      actor: user,
      organizationIds,
      columns: ["t.owner_organization_id"],
      startIndex: 2,
    });
    const result = await pool.query(`
      SELECT t.*, v.id AS current_version_id, v.version AS current_version
      FROM role_templates AS t
      LEFT JOIN LATERAL (
        SELECT id, version
        FROM role_template_versions
        WHERE template_id = t.id
        ORDER BY version DESC
        LIMIT 1
      ) AS v ON true
      WHERE t.application_id = $1 AND ${resourceScope.clause}
      ORDER BY t.code ASC
    `, [appId, ...resourceScope.values]);
    return Response.json({ roleTemplates: result.rows.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      code: row.code,
      name: row.name,
      status: row.status,
      ownerOrganizationId: row.owner_organization_id,
      currentVersionId: row.current_version_id,
      currentVersion: row.current_version,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user, appId, scope } = await requireCurrentAccessAdmin(request);
    if (scope !== "PLATFORM") throw new ResearchApiError("FORBIDDEN", "应用级角色模板变更需要平台范围授权", 403);
    const body = await readResearchJson(request);
    const applicationId = parseAccessAppId(body.applicationId);
    if (applicationId !== appId) throw new ResearchApiError("FORBIDDEN", "不能管理其他应用的角色模板", 403);
    const code = limitedText(body.code, "code", 80);
    const name = limitedText(body.name, "name", 120);
    const permissions = parseRolePermissions(body.permissions, applicationId);
    if (permissions.some((permission) => SENSITIVE_PERMISSION_KEYS.has(permission.permissionKey))) {
      throw new ResearchApiError("SENSITIVE_APPROVAL_REQUIRED", "包含敏感权限的模板必须走双人审批", 409);
    }
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const templateId = crypto.randomUUID();
      await client.query(`
        INSERT INTO role_templates (id, application_id, code, name, status, created_by_user_id)
        VALUES ($1, $2, $3, $4, 'published', $5)
      `, [templateId, applicationId, code, name, user.id]);
      await client.query(`
        INSERT INTO role_template_versions (id, template_id, version, permissions_json, change_summary, published_by_user_id)
        VALUES ($1, $2, 1, $3::jsonb, $4, $5)
      `, [crypto.randomUUID(), templateId, JSON.stringify(permissions), String(body.changeSummary ?? "initial").slice(0, 500), user.id]);
      await client.query(`
        INSERT INTO authorization_audit_events
          (id, actor_user_id, application_id, action, subject_type, subject_id, before_json, after_json)
        VALUES ($1, $2, $3, 'role_template.publish', 'role_template', $4, '{}'::jsonb, $5::jsonb)
      `, [crypto.randomUUID(), user.id, appId, templateId, JSON.stringify({ code, name, version: 1, auditSource: "automatic" })]);
      await client.query("COMMIT");
      return Response.json({ roleTemplate: { id: templateId, applicationId, code, name, version: 1 } }, { status: 201 });
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
