import { currentRequestAudience } from "@/lib/access-control";
import { hashPassword, randomToken, sha256 } from "@/lib/auth";
import { consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { consumePasswordReset } from "@/lib/password-reset";
import { mfaEnforcementEnabled } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import {
  authConnectionBucketKey,
  sessionCookieHeaders,
  sessionDeadlinesForAudience,
} from "@/lib/riverton-apps";
import { responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const audience = currentRequestAudience(request);
    const { token = "", password = "" } = await request.json() as { token?: string; password?: string };
    const pool = await getPostgresPool();
    const connection = authConnectionBucketKey(request);
    if (!connection) return Response.json({ error: "请求网络身份不可用" }, { status: 503 });
    const tokenHash = await sha256(token);
    const rateLimit = await consumeAuthRateLimit(pool, {
      action: "reset_password",
      audience,
      bucketKeys: [`token:${tokenHash}`, connection.bucketKey],
      maxAttempts: 5,
      windowSeconds: 15 * 60,
      blockSeconds: 30 * 60,
    });
    if (!rateLimit.allowed) {
      return Response.json({ error: "重置尝试过于频繁，请稍后重试" }, {
        status: 429,
        headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      });
    }

    const now = new Date();
    const internal = audience !== "client";
    const mfaEnforced = mfaEnforcementEnabled();
    const sessionToken = internal && mfaEnforced ? randomToken() : null;
    const deadlines = sessionDeadlinesForAudience(audience, now);
    if (internal) deadlines.idleExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const result = await consumePasswordReset(pool, {
      tokenHash,
      passwordHash: await hashPassword(password),
      audience,
      mfaEnforced,
      now,
      primarySession: sessionToken ? {
        id: crypto.randomUUID(),
        tokenHash: await sha256(sessionToken),
        expiresAt: deadlines.absoluteExpiresAt,
        idleExpiresAt: deadlines.idleExpiresAt,
        absoluteExpiresAt: deadlines.absoluteExpiresAt,
        ipAddress: connection.ipAddress,
        userAgent: request.headers.get("user-agent"),
      } : undefined,
    });
    if (!result.ok) return Response.json({ error: "重置链接无效、已过期或账号尚未授权" }, { status: 400 });
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    if (sessionToken) {
      const cookie = sessionCookieHeaders({
        request,
        token: sessionToken,
        maxAgeSeconds: Math.floor((new Date(deadlines.absoluteExpiresAt).getTime() - now.getTime()) / 1000),
      });
      for (const value of cookie.headers) headers.append("set-cookie", value);
    }
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    return responseError(error);
  }
}
