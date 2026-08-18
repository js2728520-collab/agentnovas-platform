import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships, personalAgents } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { currentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureD1Schema();
  const user = await currentUser(request);
  const membership = user ? (await getDb().select({ planCode: memberships.planCode, status: memberships.status, expiresAt: memberships.expiresAt }).from(memberships).where(eq(memberships.customerId, user.id)).orderBy(desc(memberships.createdAt)).limit(1))[0] ?? null : null;
  const personalAgent = user ? Boolean((await getDb().select({ id: personalAgents.id }).from(personalAgents).where(and(eq(personalAgents.userId, user.id), eq(personalAgents.status, "active"))).limit(1))[0]) : false;
  return Response.json({ user: user ? { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, phone: user.phone, dateOfBirth: user.dateOfBirth, gender: user.gender, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone, personalAgent, membership } : null });
}
