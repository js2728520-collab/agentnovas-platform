import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens, notificationDeliveries, users } from "@/db/schema";
import { currentRequestAudience } from "@/lib/access-control";
import { normalizeEmail, randomToken, sha256 } from "@/lib/auth";

export async function POST(request: Request) {
  if (currentRequestAudience(request) !== "client") {
    return Response.json({ error: "当前应用不提供密码找回" }, { status: 404 });
  }
  const { email = "" } = await request.json() as { email?: string };
  const db = getDb();
  const user = (await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1))[0];
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
