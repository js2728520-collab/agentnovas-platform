import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens, users } from "@/db/schema";
import { currentRequestAudience } from "@/lib/access-control";
import { sha256 } from "@/lib/auth";
import { getPostgresPool } from "@/lib/postgres";

export async function POST(request: Request) {
  const { token = "" } = await request.json() as { token?: string }; const db = getDb(); const now = new Date().toISOString();
  const tokenHash = await sha256(token);
  if (currentRequestAudience(request) === "client") {
    const verified = await (await getPostgresPool()).query<{ user_id: string | null }>(
      "SELECT client_verify_email($1,$2) AS user_id",
      [tokenHash,now],
    );
    return verified.rows[0]?.user_id
      ? Response.json({ ok: true })
      : Response.json({ error: "验证链接无效或已过期" }, { status: 400 });
  }
  const row = (await db.select().from(authTokens).where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, "verify_email"), isNull(authTokens.usedAt))).limit(1))[0];
  if (!row || row.expiresAt < now) return Response.json({ error: "验证链接无效或已过期" }, { status: 400 });
  await db.batch([db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id)), db.update(users).set({ emailVerifiedAt: now, status: "active", updatedAt: now }).where(eq(users.id, row.userId))]);
  return Response.json({ ok: true });
}
