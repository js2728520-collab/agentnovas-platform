import { ACCESS_ADMIN_PERMISSIONS } from "@/lib/access-management";
import { requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, [...ACCESS_ADMIN_PERMISSIONS]);
    const pool = await getPostgresPool();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 300);
    const result = await pool.query(`
      SELECT id, actor_user_id, application_id, action, subject_type, subject_id,
             before_json, after_json, ip_address, user_agent, created_at
      FROM authorization_audit_events
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return Response.json({ auditEvents: result.rows }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

