import { requireCurrentAccessAdmin } from "@/lib/access-control";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, appId, scope } = await requireCurrentAccessAdmin(request);
    if (scope !== "PLATFORM") throw new ResearchApiError("FORBIDDEN", "应用级角色发布需要平台范围授权", 403);
    const { id } = await context.params;
    await readResearchJson(request);
    const reason = automaticAuditReason("internal.access.role.publish");
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`
        UPDATE roles
        SET status = 'published', updated_at = now()
        WHERE id = $1 AND application_id = $2 AND status IN ('draft', 'disabled')
        RETURNING id, application_id, code, name, kind, status
      `, [id, appId]);
      const role = result.rows[0];
      if (!role) throw new ResearchApiError("NOT_FOUND", "角色不存在或状态不可发布", 404);
      await client.query(`
        INSERT INTO authorization_audit_events
          (id, actor_user_id, application_id, action, subject_type, subject_id, before_json, after_json)
        VALUES ($1, $2, $3, 'role.publish', 'role', $4, $5::jsonb, $6::jsonb)
      `, [crypto.randomUUID(), user.id, appId, id, JSON.stringify({ status: "draft_or_disabled" }), JSON.stringify({ status: "published", reason, auditSource: "automatic" })]);
      await client.query("COMMIT");
      return Response.json({ role });
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
