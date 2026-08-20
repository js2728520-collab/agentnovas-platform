import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens, notificationDeliveries, users } from "@/db/schema";
import { currentRequestAudience } from "@/lib/access-control";
import { normalizeEmail, randomToken, sha256 } from "@/lib/auth";
import { consumeAuthRateLimit } from "@/lib/auth-rate-limit";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { clientIpFromRequest } from "@/lib/riverton-apps";

export async function POST(request: Request) {
  if (currentRequestAudience(request) !== "client") {
    return Response.json({ error: "当前应用不提供密码找回" }, { status: 404 });
  }
  const { email = "" } = await request.json() as { email?: string };
  await ensureDatabaseSchema();
  const normalizedEmail = normalizeEmail(email);
  const ipAddress = clientIpFromRequest(request);
  const rateLimit = await consumeAuthRateLimit(await getPostgresPool(), {
    action: "forgot_password",
    audience: "client",
    bucketKeys: [`identifier:${normalizedEmail}`, ...(ipAddress ? [`ip:${ipAddress}`] : [])],
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
  const db = getDb();
  const user = (await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1))[0];
  if (user) {
    const token = randomToken();
    const now = new Date().toISOString();
    await db.batch([
      db.insert(authTokens).values({
        id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256(token), purpose: "reset_password",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      db.insert(notificationDeliveries).values({
        id: crypto.randomUUID(), userId: user.id, channel: "email", category: "login_security",
        templateKey: "reset_password", payloadJson: JSON.stringify({ token }), scheduledAt: now,
      }),
    ]);
  }
  return Response.json({ ok: true, message: "如果邮箱存在，重置邮件已进入发送队列" });
}
