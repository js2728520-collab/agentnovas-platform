import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { currentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureD1Schema();
  const user = await currentUser(request);
  const membership = user ? (await getDb().select({ planCode: memberships.planCode, status: memberships.status, expiresAt: memberships.expiresAt }).from(memberships).where(eq(memberships.customerId, user.id)).orderBy(desc(memberships.createdAt)).limit(1))[0] ?? null : null;
  return Response.json({ user: user ? { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone, membership } : null });
}
