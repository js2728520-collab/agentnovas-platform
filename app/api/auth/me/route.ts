import { ensureD1Schema } from "@/lib/d1-migrations";
import { currentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureD1Schema();
  const user = await currentUser(request);
  return Response.json({ user: user ? { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone } : null });
}
