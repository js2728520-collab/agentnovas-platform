import { requireCurrentAccessAudit } from "@/lib/access-control";
import { accessPageCursor, parseAccessPageCursor } from "@/lib/access-center-scope";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { appId, user, scope } = await requireCurrentAccessAudit(request);
    const pool = await getPostgresPool();
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 300) : 100;
    const cursor = parseAccessPageCursor(url.searchParams.get("cursor"));
    const values: unknown[] = [appId];
    const actorClause = scope === "PLATFORM" ? "TRUE" : `actor_user_id = $${values.push(user.id)}`;
    const cursorClause = cursor
      ? `(created_at, id) < ($${values.push(cursor.createdAt)}::timestamptz, $${values.push(cursor.id)})`
      : "TRUE";
    const limitIndex = values.push(limit + 1);
    const result = await pool.query(`
      SELECT id, actor_user_id, application_id, action, subject_type, subject_id,
             before_json, after_json, ip_address, user_agent, created_at
      FROM authorization_audit_events
      WHERE application_id = $1 AND ${actorClause} AND ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIndex}
    `, values);
    const page = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? page.at(-1) : null;
    return Response.json({ auditEvents: page.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      applicationId: row.application_id,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      before: row.before_json,
      after: row.after_json,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })), nextCursor: next ? accessPageCursor({
      createdAt: next.created_at instanceof Date ? next.created_at.toISOString() : next.created_at,
      id: next.id,
    }) : null }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
