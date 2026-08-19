import { eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, sessions, users } from "@/db/schema";
import { normalizeEmail, randomToken, sha256, verifyPassword } from "@/lib/auth";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizePhone } from "@/lib/phone";
import { getPostgresPool } from "@/lib/postgres";
import { legacyPermissionsForApp } from "@/lib/rbac";
import { clientIpFromRequest, sessionCookieHeaders } from "@/lib/riverton-apps";
import { responseError } from "@/lib/session";

async function userCanAccessApp(userId: string, role: string, appAudience: "client" | "operations" | "maintenance") {
  if (legacyPermissionsForApp(role, appAudience).length > 0) return true;
  try {
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT 1
      FROM user_role_assignments
      WHERE user_id = $1
        AND application_id = $2
        AND status = 'active'
        AND effective_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `, [userId, appAudience]);
    return Boolean(result.rows[0]);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "42P01" || code === "42703") return false;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { identifier?: string; email?: string; password?: string };
    await ensureDatabaseSchema();
    const db = getDb();
    const rawIdentifier = String(body.identifier ?? body.email ?? "").trim();
    const email = normalizeEmail(rawIdentifier);
    const phone = normalizePhone(rawIdentifier)?.value ?? "__not_a_phone__";
    const user = (await db.select().from(users).where(or(eq(users.phone, phone), eq(users.email, email), eq(users.username, rawIdentifier))).limit(1))[0];

    if (!user || !(await verifyPassword(body.password ?? "", user.passwordHash))) {
      return Response.json({ error: "账号或密码错误" }, { status: 401 });
    }
    if (user.status !== "active") return Response.json({ error: "账户当前不可登录" }, { status: 403 });

    const token = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const sessionCookie = sessionCookieHeaders({ request, token, maxAgeSeconds: 604800 });
    if (!await userCanAccessApp(user.id, user.role, sessionCookie.audience)) {
      return Response.json({ error: "无权登录当前应用" }, { status: 403 });
    }
    await db.batch([
      db.insert(sessions).values({ id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256(token), appAudience: sessionCookie.audience, expiresAt, ipAddress: clientIpFromRequest(request), userAgent: request.headers.get("user-agent") }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: "auth.login", subjectType: "user", subjectId: user.id, afterJson: JSON.stringify({ appAudience: sessionCookie.audience }), ipAddress: clientIpFromRequest(request), userAgent: request.headers.get("user-agent") }),
    ]);
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of sessionCookie.headers) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ ok: true, appAudience: sessionCookie.audience, user: { id: user.id, email: user.email, phone: user.phone, username: user.username, role: user.role } }), { headers });
  } catch (error) {
    return responseError(error);
  }
}
