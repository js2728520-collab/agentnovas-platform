import {
  clearAuthRateLimit,
  consumeAuthRateLimit,
  mfaChallengeRateLimitBucketKeys,
} from "@/lib/auth-rate-limit";
import { confirmMfaEnrollment } from "@/lib/mfa";
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
    if (!limit.allowed) return Response.json({ error: "双重验证尝试过于频繁" }, { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } });
    const now = new Date();
    const absoluteExpiresAt = Date.parse(current.session.absoluteExpiresAt ?? "");
    if (!Number.isFinite(absoluteExpiresAt)) return Response.json({ error: "登录验证已失效，请重新登录" }, { status: 401 });
    const idleExpiresAt = new Date(Math.min(
      absoluteExpiresAt,
      now.getTime() + sessionPolicyForAudience(current.session.appAudience).idleSeconds * 1000,
    )).toISOString();
    const result = await confirmMfaEnrollment(pool, {
      userId: current.user.id,
      sessionId: current.session.id,
      sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
      audience: current.session.appAudience,
      code,
      idleExpiresAt,
      now,
    });
    if (!result.ok) return Response.json({ error: "验证码无效或绑定状态已变化" }, { status: 400 });
    await clearAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: current.session.appAudience,
      bucketKeys,
    });
    return Response.json({
      ok: true,
      recoveryCodes: result.recoveryCodes,
      warning: "恢复码仅显示一次，请立即保存到安全位置",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
