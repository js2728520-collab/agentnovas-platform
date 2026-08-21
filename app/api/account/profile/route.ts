import { and, eq, ne, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { isAvatarPreset } from "@/lib/avatar-presets";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";

function safeUser(user: typeof users.$inferSelect) {
  return { id: user.id, email: user.email, username: user.username, nickname: user.nickname, avatarUrl: user.avatarUrl, phone: user.phone, dateOfBirth: user.dateOfBirth, gender: user.gender, role: user.role, organizationId: user.organizationId, locale: user.locale, timezone: user.timezone };
}

function validDateOfBirth(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    && parsed.getTime() <= Date.now();
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
    const input = await readResearchJson(request, 4_096);
    const username = String(input.username ?? "").trim();
    const nickname = String(input.nickname ?? "").trim();
    const avatarUrl = String(input.avatarUrl ?? "").trim();
    const phone = String(input.phone ?? "").trim();
    const dateOfBirth = String(input.dateOfBirth ?? "").trim();
    const gender = String(input.gender ?? "").trim();
    const timezone = String(input.timezone ?? "").trim();
    if (username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new ResearchApiError("PROFILE_USERNAME_INVALID", "用户名须为 3–32 位字母、数字、点、横线或下划线", 422);
    if (nickname.length > 40) throw new ResearchApiError("PROFILE_NICKNAME_INVALID", "昵称最多 40 个字符", 422);
    if (phone && (!/^[+\d()\s.-]{3,32}$/.test(phone) || phone.replace(/\D/g, "").length < 3)) throw new ResearchApiError("PROFILE_PHONE_INVALID", "手机号格式不正确", 422);
    if (dateOfBirth && !validDateOfBirth(dateOfBirth)) throw new ResearchApiError("PROFILE_DATE_INVALID", "出生日期格式不正确或晚于今天", 422);
    if (gender && !["female", "male", "other"].includes(gender)) throw new ResearchApiError("PROFILE_GENDER_INVALID", "性别选项不正确", 422);
    if (timezone && !["Asia/Shanghai", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"].includes(timezone)) throw new ResearchApiError("PROFILE_TIMEZONE_INVALID", "时区选项不正确", 422);
    if (avatarUrl && !isAvatarPreset(avatarUrl)) throw new ResearchApiError("PROFILE_AVATAR_INVALID", "头像只能从网站预设头像中选择", 422);
    const db = getDb();
    const nameTaken = async (name: string) => (await db.select({ id: users.id }).from(users).where(and(
      ne(users.id, current.id),
      or(
        sql`lower(${users.username}) = lower(${name})`,
        sql`lower(${users.nickname}) = lower(${name})`,
      ),
    )).limit(1))[0];
    if (username && await nameTaken(username)) throw new ResearchApiError("USERNAME_TAKEN", "该用户名已被使用", 409);
    if (nickname && nickname.toLowerCase() !== username.toLowerCase() && await nameTaken(nickname)) throw new ResearchApiError("NICKNAME_TAKEN", "该昵称已被使用", 409);
    try {
      await db.update(users).set({ username: username || null, nickname, avatarUrl, phone: phone || null, dateOfBirth: dateOfBirth || null, gender, timezone, updatedAt: new Date().toISOString() }).where(eq(users.id, current.id));
    } catch (error) {
      if (error instanceof Error && /unique constraint|duplicate key/i.test(error.message)) throw new ResearchApiError("NAME_TAKEN", "该用户名或昵称已被使用", 409);
      throw error;
    }
    const updated = await db.query.users.findFirst({ where: eq(users.id, current.id) });
    return Response.json({ ok: true, user: updated ? safeUser(updated) : null }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return responseError(error, request.headers.get("x-request-id") ?? undefined); }
}
