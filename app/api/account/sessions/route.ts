import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireCurrentSession } from "@/lib/session";

function maskIpAddress(value: string | null) {
  if (!value) return null;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.x.x`;
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}::`;
  return "已记录";
}

function summarizeUserAgent(value: string | null) {
  if (!value) return "未知设备";
  const browser = /Edg\//.test(value) ? "Edge" : /Chrome\//.test(value) ? "Chrome" : /Firefox\//.test(value) ? "Firefox" : /Safari\//.test(value) ? "Safari" : "浏览器";
  const system = /iPhone|iPad/.test(value) ? "iOS" : /Android/.test(value) ? "Android" : /Mac OS X/.test(value) ? "macOS" : /Windows/.test(value) ? "Windows" : /Linux/.test(value) ? "Linux" : "未知系统";
  return `${browser} · ${system}`;
}

export async function GET(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string;
      app_audience: string;
      created_at: string;
      last_seen_at: string | null;
      idle_expires_at: string;
      absolute_expires_at: string;
      ip_address: string | null;
      user_agent: string | null;
    }>(current.session.appAudience === "client" ? `
      SELECT id,app_audience,created_at,last_seen_at,idle_expires_at,
             absolute_expires_at,ip_address,user_agent
        FROM client_list_sessions($1,$2)
    ` : `
      SELECT session.id,session.app_audience,session.created_at,session.last_seen_at,
             session.idle_expires_at,session.absolute_expires_at,session.ip_address,session.user_agent
        FROM sessions AS session
       WHERE session.user_id=$1
         AND session.revoked_at IS NULL
         AND session.absolute_expires_at::timestamptz>now()
       ORDER BY COALESCE(session.last_seen_at,session.created_at::timestamptz) DESC,session.id DESC
       LIMIT 50
    `, current.session.appAudience === "client" ? [current.session.tokenHash,new Date()] : [current.user.id]);
    return Response.json({ sessions: result.rows.map((session) => ({
      id: session.id,
      audience: session.app_audience,
      current: session.id === current.session.id,
      device: summarizeUserAgent(session.user_agent),
      maskedIpAddress: maskIpAddress(session.ip_address),
      createdAt: new Date(session.created_at).toISOString(),
      lastSeenAt: session.last_seen_at ? new Date(session.last_seen_at).toISOString() : null,
      idleExpiresAt: new Date(session.idle_expires_at).toISOString(),
      absoluteExpiresAt: new Date(session.absolute_expires_at).toISOString(),
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    const body = await readResearchJson(request, 2_048);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!sessionId || sessionId.length > 160) throw new ResearchApiError("SESSION_ID_INVALID", "会话标识无效", 422);
    if (reason.length < 3 || reason.length > 500) throw new ResearchApiError("SESSION_REASON_INVALID", "撤销原因需要 3–500 个字符", 422);
    if (sessionId === current.session.id) throw new ResearchApiError("CURRENT_SESSION_LOGOUT_REQUIRED", "当前会话请使用退出登录", 422);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const revoked = current.session.appAudience === "client"
        ? await client.query<{ app_audience: string }>(`
            SELECT client_revoke_session($1,$2,$3) AS app_audience
          `, [current.session.tokenHash,sessionId,new Date()])
        : await client.query(`
        UPDATE sessions AS session
           SET revoked_at=now()
         WHERE session.id=$2 AND session.user_id=$1 AND session.revoked_at IS NULL
         RETURNING session.id,session.app_audience
      `, [current.user.id, sessionId]);
      if (!revoked.rowCount || !revoked.rows[0]?.app_audience) throw new ResearchApiError("SESSION_NOT_FOUND", "会话不存在或已经撤销", 404);
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,$2,'account.session_revoked','session',$3,$4::jsonb,$5::jsonb,now())
      `, [crypto.randomUUID(), current.user.id, sessionId, JSON.stringify({ active: true }), JSON.stringify({ active: false, audience: revoked.rows[0].app_audience, reason })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, message: "该设备会话已撤销" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
