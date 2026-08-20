import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, sessions } from "@/db/schema";
import { clearAuthRateLimit, consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { verifyAndConsumeMfa } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { sessionPolicyForAudience } from "@/lib/riverton-apps";
import { requirePrimarySession, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const current = await requirePrimarySession(request);
    if (current.session.appAudience === "client") {
      return Response.json({ error: "当前应用不提供内部双重验证" }, { status: 404 });
    }
    const { code = "" } = await request.json() as { code?: string };
    const pool = await getPostgresPool();
    const bucketKey = `session:${current.session.id}`;
    const limit = await consumeAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: current.session.appAudience,
      bucketKeys: [bucketKey],
      maxAttempts: 5,
      windowSeconds: 10 * 60,
      blockSeconds: 15 * 60,
    });
    if (!limit.allowed) {
      return Response.json({ error: "双重验证尝试过于频繁，请重新登录后再试" }, {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSeconds) },
      });
    }
    const result = await verifyAndConsumeMfa(pool, { userId: current.user.id, code });
    if (!result.ok) return Response.json({ error: "验证码无效、已使用或已过期" }, { status: 401 });

    const now = new Date();
    const nowIso = now.toISOString();
    const idleExpiresAt = new Date(Math.min(
      Date.parse(current.session.absoluteExpiresAt!),
      now.getTime() + sessionPolicyForAudience(current.session.appAudience).idleSeconds * 1000,
    )).toISOString();
    const db = getDb();
    await db.batch([
      db.update(sessions).set({
        mfaLevel: result.level,
        mfaVerifiedAt: nowIso,
        lastSeenAt: nowIso,
        idleExpiresAt,
      }).where(and(eq(sessions.id, current.session.id), isNull(sessions.revokedAt))),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: current.user.id,
        action: result.level === "recovery" ? "auth.mfa_recovery_verified" : "auth.mfa_totp_verified",
        subjectType: "session",
        subjectId: current.session.id,
        afterJson: JSON.stringify({ appAudience: current.session.appAudience, level: result.level }),
      }),
    ]);
    await clearAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: current.session.appAudience,
      bucketKeys: [bucketKey],
    });
    return Response.json({ ok: true, mfaLevel: result.level });
  } catch (error) {
    return responseError(error);
  }
}
