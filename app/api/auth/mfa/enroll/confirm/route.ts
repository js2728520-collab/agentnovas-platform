import { consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { confirmMfaEnrollment } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { sessionPolicyForAudience } from "@/lib/riverton-apps";
import { requirePrimarySession, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const current = await requirePrimarySession(request);
    if (current.session.appAudience === "client") return Response.json({ error: "当前应用不提供内部双重验证" }, { status: 404 });
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
      audience: current.session.appAudience,
      code,
      idleExpiresAt,
      now,
    });
    if (!result.ok) return Response.json({ error: "验证码无效或绑定状态已变化" }, { status: 400 });
    return Response.json({
      ok: true,
      recoveryCodes: result.recoveryCodes,
      warning: "恢复码仅显示一次，请立即保存到安全位置",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
