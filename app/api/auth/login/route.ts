import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, sessions, users } from "@/db/schema";
import { normalizeEmail, randomToken, sha256, verifyPassword } from "@/lib/auth";
import { responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const db = getDb();
    const email = normalizeEmail(body.email ?? "");
    const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    if (!user || !(await verifyPassword(body.password ?? "", user.passwordHash))) return Response.json({ error: "邮箱或密码错误" }, { status: 401 });
    if (!user.emailVerifiedAt) return Response.json({ error: "请先完成邮箱验证" }, { status: 403 });
    if (user.status !== "active") return Response.json({ error: "账户当前不可登录" }, { status: 403 });
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    await db.batch([
      db.insert(sessions).values({ id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256(token), expiresAt, ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: "auth.login", subjectType: "user", subjectId: user.id, ipAddress: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") }),
    ]);
    return new Response(JSON.stringify({ ok: true, user: { id: user.id, email: user.email, role: user.role } }), { headers: { "content-type": "application/json", "set-cookie": `an_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` } });
  } catch (error) {
    return responseError(error);
  }
}
