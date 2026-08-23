import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, sessions } from "@/db/schema";
import {
  clearAuthRateLimit,
  consumeAuthRateLimit,
  mfaChallengeRateLimitBucketKeys,
} from "@/lib/auth-rate-limit";
import { verifyAndConsumeMfa } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson } from "@/lib/research-api";
import { authConnectionBucketKey, sessionPolicyForAudience } from "@/lib/riverton-apps";
import { requirePrimarySession, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const current = await requirePrimarySession(request);
    const body = await readResearchJson(request, 2_048);
    const code = typeof body.code === "string" ? body.code : "";
    const pool = await getPostgresPool();
    const connection = authConnectionBucketKey(request);
    if (!connection) return Response.json({ error: "请求网络身份不可用" }, { status: 503 });
    const bucketKeys = mfaChallengeRateLimitBucketKeys({
      sessionId: current.session.id,
      userId: current.user.id,
      connectionBucketKey: connection.bucketKey,
    });
    const limit = await consumeAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: current.session.appAudience,
      bucketKeys,
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
    const result = await verifyAndConsumeMfa(pool, {
      userId: current.user.id,
      sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
      code,
    });
    if (!result.ok) return Response.json({ error: "验证码无效、已使用或已过期" }, { status: 401 });

    const now = new Date();
    const nowIso = now.toISOString();
    const idleExpiresAt = new Date(Math.min(
      Date.parse(current.session.absoluteExpiresAt!),
      now.getTime() + sessionPolicyForAudience(current.session.appAudience).idleSeconds * 1000,
    )).toISOString();
    const db = getDb();
    if (current.session.appAudience === "client") {
      const changed = await pool.query<{ changed: boolean }>(`
        SELECT client_mfa_mark_session_verified($1,$2,$3,$4) AS changed
      `, [current.session.tokenHash,result.level,now,idleExpiresAt]);
      if (!changed.rows[0]?.changed) return Response.json({ error: "登录验证已失效，请重新登录" }, { status: 409 });
      await db.insert(auditLogs).values({
        id: crypto.randomUUID(),actorUserId: current.user.id,
        action: result.level === "recovery" ? "auth.mfa_recovery_verified" : "auth.mfa_totp_verified",
        subjectType: "session",subjectId: current.session.id,
        afterJson: JSON.stringify({ appAudience: current.session.appAudience,level: result.level }),
      });
    } else await db.batch([
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
      bucketKeys,
    });
    return Response.json({ ok: true, mfaLevel: result.level });
  } catch (error) {
    return responseError(error);
  }
}
