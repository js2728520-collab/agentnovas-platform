import { currentRequestAudience } from "@/lib/access-control";
import { normalizeEmail, validEmail } from "@/lib/auth";
import { consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { queueEmailVerificationRequest } from "@/lib/email-verification";
import { getClientAuthPostgresPool, getPostgresPool } from "@/lib/postgres";
import { readResearchJson } from "@/lib/research-api";
import { authConnectionBucketKey } from "@/lib/riverton-apps";

export async function POST(request: Request) {
  if (currentRequestAudience(request) !== "client") {
    return Response.json({ error: "当前应用不提供邮箱验证" }, { status: 404 });
  }
  const body = await readResearchJson(request, 2_048);
  const email = normalizeEmail(String(body.email ?? ""));
  if (!validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
  await ensureDatabaseSchema();
  const connection = authConnectionBucketKey(request);
  if (!connection) return Response.json({ error: "请求网络身份不可用" }, { status: 503 });
  const rateLimit = await consumeAuthRateLimit(await getPostgresPool(), {
    action: "verify_email",
    audience: "client",
    bucketKeys: [`identifier:${email}`, connection.bucketKey],
    maxAttempts: 3,
    windowSeconds: 60 * 60,
    blockSeconds: 60 * 60,
  });
  if (!rateLimit.allowed) {
    return Response.json({ error: "请求过于频繁，请稍后重试" }, {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": String(rateLimit.retryAfterSeconds) },
    });
  }
  await queueEmailVerificationRequest(await getClientAuthPostgresPool(), { email });
  return Response.json({
    ok: true,
    message: "如果该邮箱存在待验证账户，新的验证邮件已进入发送队列",
  }, { headers: { "cache-control": "no-store" } });
}
