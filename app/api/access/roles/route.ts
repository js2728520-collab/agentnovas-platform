import { ACCESS_ADMIN_PERMISSIONS, limitedText, parseAccessAppId, parseRolePermissions } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT r.*, COALESCE(
        jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope))
          FILTER (WHERE rp.id IS NOT NULL),
        '[]'::jsonb
      ) AS permissions
      FROM roles AS r
      LEFT JOIN role_permissions AS rp ON rp.role_id = r.id
      GROUP BY r.id
      ORDER BY r.application_id ASC, r.code ASC
    `);
    return Response.json({ roles: result.rows }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const body = await readResearchJson(request);
    const applicationId = parseAccessAppId(body.applicationId);
    const code = limitedText(body.code, "code", 80);
    const name = limitedText(body.name, "name", 120);
    const kind = String(body.kind ?? "custom");
    if (!["custom", "derived"].includes(kind)) throw new ResearchApiError("VALIDATION_ERROR", "角色类型无效", 422, { fields: ["kind"] });
    const permissions = parseRolePermissions(body.permissions, applicationId);
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
    return researchErrorResponse(error);
  }
}

