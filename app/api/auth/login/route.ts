import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, sessions, users } from "@/db/schema";
import { effectiveAccessForUser } from "@/lib/access-control";
import { dummyVerifyPassword, hashPassword, normalizeEmail, randomToken, sha256, verifyPasswordState } from "@/lib/auth";
import { clearAuthRateLimit, consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizePhone } from "@/lib/phone";
import { getPostgresPool } from "@/lib/postgres";
import { authConnectionBucketKey, sessionCookieHeaders, sessionDeadlinesForAudience } from "@/lib/riverton-apps";
import { responseError } from "@/lib/session";

async function userCanAccessApp(user: typeof users.$inferSelect, appAudience: "client" | "operations" | "maintenance") {
  const access = await effectiveAccessForUser(await getPostgresPool(), user, appAudience);
  return Object.keys(access.permissions).length > 0;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { identifier?: string; email?: string; password?: string };
    await ensureDatabaseSchema();
    const db = getDb();
    const rawIdentifier = String(body.identifier ?? body.email ?? "").trim();
    const email = normalizeEmail(rawIdentifier);
    const phone = normalizePhone(rawIdentifier)?.value ?? "__not_a_phone__";
    const pool = await getPostgresPool();
    const connection = authConnectionBucketKey(request);
    if (!connection) return Response.json({ error: "登录网络身份不可用" }, { status: 503 });
    const ipAddress = connection.ipAddress;
    const provisionalCookie = sessionCookieHeaders({ request, token: "pending", maxAgeSeconds: 1 });
    const identifierBucket = `identifier:${rawIdentifier.toLowerCase()}`;
    const rateLimit = await consumeAuthRateLimit(pool, {
      action: "login",
      audience: provisionalCookie.audience,
      bucketKeys: [identifierBucket, connection.bucketKey],
      maxAttempts: 5,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) {
      return Response.json({ error: "登录尝试过于频繁，请稍后重试" }, {
        status: 429,
        headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      });
    }
    const user = (await db.select().from(users).where(or(eq(users.phone, phone), eq(users.email, email), eq(users.username, rawIdentifier))).limit(1))[0];

    if (!user) {
      await dummyVerifyPassword(body.password ?? "");
      return Response.json({ error: "账号或密码错误" }, { status: 401 });
    }
    const passwordState = await verifyPasswordState(body.password ?? "", user.passwordHash);
    if (!passwordState.valid) return Response.json({ error: "账号或密码错误" }, { status: 401 });
    if (user.status !== "active") return Response.json({ error: "账户当前不可登录" }, { status: 403 });

    const token = randomToken();
    const now = new Date();
    const deadlines = sessionDeadlinesForAudience(provisionalCookie.audience, now);
    const sessionCookie = sessionCookieHeaders({
      request,
      token,
      maxAgeSeconds: Math.floor((new Date(deadlines.absoluteExpiresAt).getTime() - now.getTime()) / 1000),
    });
    if (!await userCanAccessApp(user, sessionCookie.audience)) {
      return Response.json({ error: "无权登录当前应用" }, { status: 403 });
    }
    const mfaRequired = sessionCookie.audience !== "client";
    let mfaEnrollmentRequired = false;
    if (mfaRequired) {
      const enrollment = await pool.query(`
        SELECT 1 FROM user_mfa_totp_credentials
        WHERE user_id = $1 AND status = 'active'
      `, [user.id]);
      mfaEnrollmentRequired = !enrollment.rowCount;
      deadlines.idleExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    }
    if (passwordState.needsRehash) {
      await db.update(users).set({ passwordHash: await hashPassword(body.password ?? ""), updatedAt: now.toISOString() })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)));
    }
    await clearAuthRateLimit(pool, { action: "login", audience: sessionCookie.audience, bucketKeys: [identifierBucket, connection.bucketKey] });
    await db.batch([
      db.insert(sessions).values({
        id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256(token), appAudience: sessionCookie.audience,
        expiresAt: deadlines.absoluteExpiresAt, mfaLevel: "primary", ...deadlines,
        ipAddress, userAgent: request.headers.get("user-agent"),
      }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: mfaRequired ? "auth.primary_authenticated" : "auth.login", subjectType: "user", subjectId: user.id, afterJson: JSON.stringify({ appAudience: sessionCookie.audience, mfaRequired }), ipAddress, userAgent: request.headers.get("user-agent") }),
    ]);
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of sessionCookie.headers) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ ok: true, mfaRequired, mfaEnrollmentRequired, appAudience: sessionCookie.audience, user: { id: user.id, email: user.email, phone: user.phone, username: user.username, role: user.role } }), { headers });
  } catch (error) {
    return responseError(error);
  }
}
