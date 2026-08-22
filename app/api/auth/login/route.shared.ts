import { and, eq, or } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, sessions, users } from "@/db/schema";
import { effectiveAccessForUser } from "@/lib/access-control";
import { dummyVerifyPassword, hashPassword, normalizeEmail, randomToken, sha256, verifyPasswordState } from "@/lib/auth";
import { clearAuthRateLimit, consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { clientLoginIdentity } from "@/lib/client-identity-gateway";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizePhone } from "@/lib/phone";
import { mfaLoginRequirement } from "@/lib/mfa";
import { getClientAuthPostgresPool, getPostgresPool } from "@/lib/postgres";
import { readResearchJson } from "@/lib/research-api";
import { authConnectionBucketKey, sessionCookieHeaders, sessionDeadlinesForAudience } from "@/lib/riverton-apps";
import { responseError } from "@/lib/session";

async function userCanAccessApp(user: typeof users.$inferSelect, appAudience: "client" | "operations" | "maintenance") {
  const access = await effectiveAccessForUser(await getPostgresPool(), user, appAudience);
  return Object.keys(access.permissions).length > 0;
}

export async function POST(request: Request) {
  try {
    const input = await readResearchJson(request, 4_096);
    const body = {
      identifier: typeof input.identifier === "string" ? input.identifier : undefined,
      email: typeof input.email === "string" ? input.email : undefined,
      password: typeof input.password === "string" ? input.password : undefined,
    };
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
    const clientIdentity = provisionalCookie.audience === "client"
      ? await clientLoginIdentity(await getClientAuthPostgresPool(), { phone,email,username: rawIdentifier })
      : null;
    const user = provisionalCookie.audience === "client"
      ? clientIdentity?.user
      : (await db.select().from(users).where(or(eq(users.phone, phone), eq(users.email, email), eq(users.username, rawIdentifier))).limit(1))[0];

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
    const enrollment = sessionCookie.audience === "client"
      ? clientIdentity?.hasActiveMfa
      : Boolean((await pool.query(`
          SELECT 1 FROM user_mfa_totp_credentials
          WHERE user_id = $1 AND status = 'active'
        `, [user.id])).rowCount);
    const requirement = mfaLoginRequirement(sessionCookie.audience, Boolean(enrollment));
    const mfaRequired = requirement.required;
    const mfaEnrollmentRequired = requirement.enrollmentRequired;
    if (mfaRequired) {
      deadlines.idleExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    }
    const replacementPasswordHash = passwordState.needsRehash ? await hashPassword(body.password ?? "") : null;
    await clearAuthRateLimit(pool, { action: "login", audience: sessionCookie.audience, bucketKeys: [identifierBucket, connection.bucketKey] });
    const sessionId = crypto.randomUUID();
    const sessionTokenHash = await sha256(token);
    if (sessionCookie.audience === "client") {
      const completed = await pool.query<{ completed: boolean }>(`
        SELECT client_complete_login(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        ) AS completed
      `, [
        user.id,user.passwordHash,replacementPasswordHash,sessionId,sessionTokenHash,
        deadlines.absoluteExpiresAt,mfaRequired ? "primary" : "none",now,
        deadlines.idleExpiresAt,deadlines.absoluteExpiresAt,ipAddress,request.headers.get("user-agent"),
      ]);
      if (!completed.rows[0]?.completed) return Response.json({ error: "账号状态已变化，请重新登录" }, { status: 409 });
      await db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: mfaRequired ? "auth.primary_authenticated" : "auth.login", subjectType: "user", subjectId: user.id, afterJson: JSON.stringify({ appAudience: sessionCookie.audience, mfaRequired }), ipAddress, userAgent: request.headers.get("user-agent") });
    } else {
      if (replacementPasswordHash) {
        await db.update(users).set({ passwordHash: replacementPasswordHash, updatedAt: now.toISOString() })
          .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)));
      }
      await db.batch([
        db.insert(sessions).values({
          id: sessionId, userId: user.id, tokenHash: sessionTokenHash, appAudience: sessionCookie.audience,
          expiresAt: deadlines.absoluteExpiresAt, mfaLevel: mfaRequired ? "primary" : "none", ...deadlines,
          ipAddress, userAgent: request.headers.get("user-agent"),
        }),
        db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: user.id, action: mfaRequired ? "auth.primary_authenticated" : "auth.login", subjectType: "user", subjectId: user.id, afterJson: JSON.stringify({ appAudience: sessionCookie.audience, mfaRequired }), ipAddress, userAgent: request.headers.get("user-agent") }),
      ]);
    }
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of sessionCookie.headers) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ ok: true, mfaRequired, mfaEnrollmentRequired, appAudience: sessionCookie.audience, user: { id: user.id, email: user.email, phone: user.phone, username: user.username, role: user.role } }), { headers });
  } catch (error) {
    return responseError(error);
  }
}
