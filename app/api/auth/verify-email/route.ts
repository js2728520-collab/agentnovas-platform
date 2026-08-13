import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens, users } from "@/db/schema";
import { sha256 } from "@/lib/auth";

export async function POST(request: Request) {
  const { token = "" } = await request.json() as { token?: string }; const db = getDb(); const now = new Date().toISOString();
  const row = (await db.select().from(authTokens).where(and(eq(authTokens.tokenHash, await sha256(token)), eq(authTokens.purpose, "verify_email"), isNull(authTokens.usedAt))).limit(1))[0];
  if (!row || row.expiresAt < now) return Response.json({ error: "验证链接无效或已过期" }, { status: 400 });
  await db.batch([db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id)), db.update(users).set({ emailVerifiedAt: now, status: "active", updatedAt: now }).where(eq(users.id, row.userId))]);
  return Response.json({ ok: true });
}
