import { and, eq, ne } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { requireUser, responseError } from "@/lib/session";

function safeUser(user: typeof users.$inferSelect) {
  return { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone };
}

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    return Response.json({ user: safeUser(await requireUser(request)) });
  } catch (error) { return responseError(error); }
}

export async function PATCH(request: Request) {
  try {
    await ensureD1Schema();
    const current = await requireUser(request);
    const input = await request.json() as { username?: unknown; nickname?: unknown; avatarUrl?: unknown };
    const username = String(input.username ?? "").trim();
    const nickname = String(input.nickname ?? "").trim();
    const avatarUrl = String(input.avatarUrl ?? "").trim();
    if (username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error("用户名须为 3–32 位字母、数字、点、横线或下划线");
    if (nickname.length > 40) throw new Error("昵称最多 40 个字符");
    if (avatarUrl.length > 420000) throw new Error("头像文件过大，请选择 300KB 以内的图片");
    if (avatarUrl && !/^https:\/\//i.test(avatarUrl) && !/^data:image\/(png|jpe?g|webp);base64,/i.test(avatarUrl)) throw new Error("头像必须是 HTTPS 图片地址或本地上传图片");
    const db = getDb();
    if (username) {
      const duplicate = await db.query.users.findFirst({ where: and(eq(users.username, username), ne(users.id, current.id)) });
      if (duplicate) return Response.json({ error: "该用户名已被使用" }, { status: 409 });
    }
    await db.update(users).set({ username: username || null, nickname, avatarUrl, updatedAt: new Date().toISOString() }).where(eq(users.id, current.id));
    const updated = await db.query.users.findFirst({ where: eq(users.id, current.id) });
    return Response.json({ ok: true, user: updated ? safeUser(updated) : null });
  } catch (error) { return responseError(error); }
}
