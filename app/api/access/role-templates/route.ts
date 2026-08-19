import { ACCESS_ADMIN_PERMISSIONS, limitedText, parseAccessAppId, parseRolePermissions } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const pool = await getPostgresPool();
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
      ORDER BY t.application_id ASC, t.code ASC
    `);
    return Response.json({ roleTemplates: result.rows }, { headers: { "cache-control": "no-store" } });
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
    const permissions = parseRolePermissions(body.permissions, applicationId);
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
      await client.query("COMMIT");
      return Response.json({ roleTemplate: { id: templateId, applicationId, code, name, version: 1 } }, { status: 201 });
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

