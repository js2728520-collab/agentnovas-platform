import { and, eq, ne, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { isAvatarPreset } from "@/lib/avatar-presets";

function safeUser(user: typeof users.$inferSelect) {
  return { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, phone: user.phone, dateOfBirth: user.dateOfBirth, gender: user.gender, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone };
}

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    return Response.json({ user: safeUser(await requireUser(request)) });
  } catch (error) { return responseError(error); }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await requireUser(request);
    const input = await request.json() as { username?: unknown; nickname?: unknown; avatarUrl?: unknown; phone?: unknown; dateOfBirth?: unknown; gender?: unknown; timezone?: unknown };
    const username = String(input.username ?? "").trim();
    const nickname = String(input.nickname ?? "").trim();
    const avatarUrl = String(input.avatarUrl ?? "").trim();
    const phone = String(input.phone ?? "").trim();
    const dateOfBirth = String(input.dateOfBirth ?? "").trim();
    const gender = String(input.gender ?? "").trim();
    const timezone = String(input.timezone ?? "").trim();
    if (username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new Error("用户名须为 3–32 位字母、数字、点、横线或下划线");
    if (nickname.length > 40) throw new Error("昵称最多 40 个字符");
    if (phone.length > 32) throw new Error("手机号最多 32 个字符");
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new Error("出生日期格式不正确");
    if (gender && !["female", "male", "other"].includes(gender)) throw new Error("性别选项不正确");
    if (timezone.length > 64) throw new Error("时区格式不正确");
    if (avatarUrl && !isAvatarPreset(avatarUrl)) throw new Error("头像只能从网站预设头像中选择");
    const db = getDb();
    const nameTaken = async (name: string) => (await db.select({ id: users.id }).from(users).where(and(
      ne(users.id, current.id),
      or(
        sql`lower(${users.username}) = lower(${name})`,
        sql`lower(${users.nickname}) = lower(${name})`,
      ),
    )).limit(1))[0];
    if (username && await nameTaken(username)) return Response.json({ error: "该用户名已被使用", code: "USERNAME_TAKEN" }, { status: 409 });
    if (nickname && nickname.toLowerCase() !== username.toLowerCase() && await nameTaken(nickname)) return Response.json({ error: "该昵称已被使用", code: "NICKNAME_TAKEN" }, { status: 409 });
    try {
      await db.update(users).set({ username: username || null, nickname, avatarUrl, phone: phone || null, dateOfBirth: dateOfBirth || null, gender, timezone, updatedAt: new Date().toISOString() }).where(eq(users.id, current.id));
    } catch (error) {
      if (error instanceof Error && /unique constraint failed/i.test(error.message)) return Response.json({ error: "该用户名或昵称已被使用", code: "NAME_TAKEN" }, { status: 409 });
      throw error;
    }
    const updated = await db.query.users.findFirst({ where: eq(users.id, current.id) });
    return Response.json({ ok: true, user: updated ? safeUser(updated) : null });
  } catch (error) { return responseError(error); }
}
