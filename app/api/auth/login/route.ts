import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, sessions, users } from "@/db/schema";
import { hashPassword, normalizeEmail, randomToken, sha256, verifyPassword } from "@/lib/auth";
import { responseError } from "@/lib/session";
import { ensureD1Schema } from "@/lib/d1-migrations";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    // Local previews start with a fresh Miniflare D1 database. Ensure the
    // same schema used by production exists before Drizzle prepares a query.
    await ensureD1Schema();
    const db = getDb();
    const email = normalizeEmail(body.email ?? "");
    let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    // A local preview can be reset independently of the production D1. If the
    // first administrator was created in a previous preview database, recreate
    // only that local bootstrap account from the credentials being submitted.
    // This branch is deliberately restricted to localhost and never runs on a
    // deployed hostname.
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
