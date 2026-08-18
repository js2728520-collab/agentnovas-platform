import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens, sessions, users } from "@/db/schema";
import { hashPassword, sha256 } from "@/lib/auth";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPlatformSetting } from "@/lib/platform-settings";

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const { token = "", password = "" } = await request.json() as { token?: string; password?: string };
    const security = await getPlatformSetting("security");
    if (password.length < security.passwordMinLength) {
      return Response.json({ error: `密码至少需要 ${security.passwordMinLength} 位` }, { status: 400 });
    }
    const db = getDb();
    const now = new Date().toISOString();
    const row = (await db.select().from(authTokens).where(and(eq(authTokens.tokenHash, await sha256(token)), eq(authTokens.purpose, "reset_password"), isNull(authTokens.usedAt))).limit(1))[0];
    if (!row || row.expiresAt < now) return Response.json({ error: "重置链接无效或已过期" }, { status: 400 });
    await db.batch([
      db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: now }).where(eq(users.id, row.userId)),
      db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id)),
      db.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, row.userId)),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "重置失败" }, { status: 400 });
  }
}
