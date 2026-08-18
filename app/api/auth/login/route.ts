import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, sessions, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, verifyPassword } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { normalizePhone } from "@/lib/phone";
import { getPlatformSetting } from "@/lib/platform-settings";
import { responseError } from "@/lib/session";
import { sessionIdsToRevoke } from "@/lib/session-policy";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { identifier?: string; email?: string; password?: string };
    await ensureD1Schema();
    const db = getDb();
    const security = await getPlatformSetting("security");
    const requestIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    if (requestIp && security.blockedIpList.includes(requestIp)) return Response.json({ error: "当前网络地址已被安全策略拦截" }, { status: 403 });
    const rawIdentifier = String(body.identifier ?? body.email ?? "").trim();
    const email = normalizeEmail(rawIdentifier);
    const normalizedPhone = normalizePhone(rawIdentifier);
    const phone = normalizedPhone?.value ?? "__not_a_phone__";
    const identifierType = rawIdentifier.includes("@") ? "email" : normalizedPhone ? "phone" : "username";
    let user = (await db.select().from(users).where(or(eq(users.phone, phone), eq(users.email, email), eq(users.username, rawIdentifier))).limit(1))[0];

    const hostname = new URL(request.url).hostname;
    if (!user && (hostname === "localhost" || hostname === "127.0.0.1") && email === "anko98727@gmail.com" && (body.password ?? "").length >= 10) {
      const adminCount = (await db.select().from(users).where(eq(users.role, "hq_admin")).limit(1))[0];
      if (!adminCount) {
        const organizationId = crypto.randomUUID();
        const userId = crypto.randomUUID();
        const now = new Date().toISOString();
        await db.batch([
          db.insert(organizations).values({ id: organizationId, type: "headquarters", name: "AgentNovas 总公司" }),
          db.insert(users).values({ id: userId, email, passwordHash: await hashPassword(body.password ?? ""), role: "hq_admin", organizationId, status: "active", emailVerifiedAt: now }),
        ]);
        user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
      }
    }

    if (!user || !(await verifyPassword(body.password ?? "", user.passwordHash))) {
      return Response.json({ error: "账号或密码错误" }, { status: 401 });
    }
    if (security.requireEmailVerification && !user.emailVerifiedAt) return Response.json({ error: "请先完成邮箱验证后再登录" }, { status: 403 });
    if (user.role === "hq_admin" && security.adminIpAllowlist.length && (!requestIp || !security.adminIpAllowlist.includes(requestIp))) return Response.json({ error: "当前网络地址不在超级管理员允许列表" }, { status: 403 });
    if (user.status !== "active") return Response.json({ error: "账户当前不可登录" }, { status: 403 });

    const token = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const now = new Date().toISOString();
    const activeSessions = await db.select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.createdAt));
    const sessionsToRevoke = sessionIdsToRevoke(activeSessions.map((session) => session.id), security.maxActiveSessions);
    await db.batch([
      ...sessionsToRevoke.map((sessionId) => db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, sessionId))),
      db.insert(sessions).values({ id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256(token), expiresAt, ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: "auth.login", subjectType: "user", subjectId: user.id, afterJson: JSON.stringify({ identifierType }), ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
    ]);
    const secureCookie = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return new Response(JSON.stringify({ ok: true, user: { id: user.id, email: user.email, phone: user.phone, username: user.username, role: user.role } }), {
      headers: { "content-type": "application/json", "set-cookie": `an_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie}` },
    });
  } catch (error) {
    return responseError(error);
  }
}
