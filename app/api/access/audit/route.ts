import { requireCurrentAccessAudit } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { appId } = await requireCurrentAccessAudit(request);
    const pool = await getPostgresPool();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 300);
    const result = await pool.query(`
      SELECT id, actor_user_id, application_id, action, subject_type, subject_id,
             before_json, after_json, ip_address, user_agent, created_at
      FROM authorization_audit_events
      WHERE application_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [appId, limit]);
    return Response.json({ auditEvents: result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      applicationId: row.application_id,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      before: row.before_json,
      after: row.after_json,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
