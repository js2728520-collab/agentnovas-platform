import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { sha256 } from "@/lib/auth";

export type CurrentUser = typeof users.$inferSelect;

function cookieValue(request: Request, name: string) {
  const item = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

export async function currentUser(request: Request): Promise<CurrentUser | null> {
  const token = cookieValue(request, "an_session"); if (!token) return null;
  const db = getDb(); const now = new Date().toISOString();
  const row = (await db.select({ user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(and(eq(sessions.tokenHash, await sha256(token)), gt(sessions.expiresAt, now), isNull(sessions.revokedAt), eq(users.status, "active"))).limit(1))[0];
  return row?.user ?? null;
}

export async function requireUser(request: Request, roles?: CurrentUser["role"][]) {
  const user = await currentUser(request);
  if (!user) throw new Response(JSON.stringify({ error: "请先登录" }), { status: 401, headers: { "content-type": "application/json" } });
  if (roles && !roles.includes(user.role)) throw new Response(JSON.stringify({ error: "无权执行此操作" }), { status: 403, headers: { "content-type": "application/json" } });
  return user;
}

export function responseError(error: unknown) {
  if (error instanceof Response) return error;
  return Response.json({ error: error instanceof Error ? error.message : "服务器处理失败" }, { status: 500 });
}
