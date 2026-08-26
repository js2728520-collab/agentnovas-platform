import { currentRequestAudience } from "@/lib/access-control";
import { normalizeEmail } from "@/lib/auth";
import { consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { queueForgotPasswordRequest } from "@/lib/forgot-password";
import { getClientAuthPostgresPool, getPostgresPool } from "@/lib/postgres";
import { authConnectionBucketKey } from "@/lib/riverton-apps";

export async function POST(request: Request) {
  if (currentRequestAudience(request) !== "client") {
    return Response.json({ error: "当前应用不提供密码找回" }, { status: 404 });
  }
  const { email = "" } = await request.json() as { email?: string };
  await ensureDatabaseSchema();
  const normalizedEmail = normalizeEmail(email);
  const connection = authConnectionBucketKey(request);
  if (!connection) return Response.json({ error: "请求网络身份不可用" }, { status: 503 });
  const pool = await getPostgresPool();
  const rateLimit = await consumeAuthRateLimit(pool, {
    action: "forgot_password",
    audience: "client",
    bucketKeys: [`identifier:${normalizedEmail}`, connection.bucketKey],
    maxAttempts: 3,
    windowSeconds: 60 * 60,
    blockSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    return Response.json({ error: "请求过于频繁，请稍后重试" }, {
      status: 429,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
    });
  }
  await queueForgotPasswordRequest(await getClientAuthPostgresPool(), { email: normalizedEmail });
  return Response.json({ ok: true, message: "如果邮箱存在，重置邮件已进入发送队列" });
}
