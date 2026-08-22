import { and, eq, ne, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireCurrentSession, requireUser, responseError } from "@/lib/session";
import { isAvatarPreset } from "@/lib/avatar-presets";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { normalizeProfilePhoneUpdate, updateAccountProfile } from "@/lib/account-profile";
import { getClientAuthPostgresPool, getPostgresPool } from "@/lib/postgres";
import { clientSelfPasswordHash } from "@/lib/client-identity-gateway";

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
    const current = await requireCurrentSession(request);
    const input = await readResearchJson(request, 4_096);
    const currentPassword = String(input.currentPassword ?? "");
    const username = String(input.username ?? "").trim();
    const nickname = String(input.nickname ?? "").trim();
    const avatarUrl = String(input.avatarUrl ?? "").trim();
    const phone = normalizeProfilePhoneUpdate(String(input.phone ?? ""), {
      email: current.user.email,
      username: username || null,
    });
    const dateOfBirth = String(input.dateOfBirth ?? "").trim();
    const gender = String(input.gender ?? "").trim();
    const timezone = String(input.timezone ?? "").trim();
    if (username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new ResearchApiError("PROFILE_USERNAME_INVALID", "用户名须为 3–32 位字母、数字、点、横线或下划线", 422);
    if (nickname.length > 40) throw new ResearchApiError("PROFILE_NICKNAME_INVALID", "昵称最多 40 个字符", 422);
    if (dateOfBirth && !validDateOfBirth(dateOfBirth)) throw new ResearchApiError("PROFILE_DATE_INVALID", "出生日期格式不正确或晚于今天", 422);
    if (gender && !["female", "male", "other"].includes(gender)) throw new ResearchApiError("PROFILE_GENDER_INVALID", "性别选项不正确", 422);
    if (timezone && !["Asia/Shanghai", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"].includes(timezone)) throw new ResearchApiError("PROFILE_TIMEZONE_INVALID", "时区选项不正确", 422);
    if (avatarUrl && !isAvatarPreset(avatarUrl)) throw new ResearchApiError("PROFILE_AVATAR_INVALID", "头像只能从网站预设头像中选择", 422);
    const db = getDb();
    const clientConflicts = current.session.appAudience === "client"
      ? (await (await getPostgresPool()).query<{
          username_exists: boolean; nickname_exists: boolean; phone_exists: boolean;
        }>("SELECT * FROM client_profile_conflicts($1,$2,$3,$4)", [
          current.session.tokenHash,username,nickname,phone,
        ])).rows[0]
      : null;
    const nameTaken = async (name: string) => clientConflicts
      ? (name === username ? clientConflicts.username_exists : clientConflicts.nickname_exists)
      : (await db.select({ id: users.id }).from(users).where(and(
          ne(users.id, current.user.id),
          or(sql`lower(${users.username}) = lower(${name})`,sql`lower(${users.nickname}) = lower(${name})`),
        )).limit(1))[0];
    if (username && await nameTaken(username)) throw new ResearchApiError("USERNAME_TAKEN", "该用户名已被使用", 409);
    if (nickname && nickname.toLowerCase() !== username.toLowerCase() && await nameTaken(nickname)) throw new ResearchApiError("NICKNAME_TAKEN", "该昵称已被使用", 409);
    const phoneTaken = clientConflicts
      ? clientConflicts.phone_exists
      : phone && (await db.select({ id: users.id }).from(users).where(and(ne(users.id, current.user.id), eq(users.phone, phone))).limit(1))[0];
    if (phone && phoneTaken) {
      throw new ResearchApiError("PHONE_TAKEN", "该手机号已被使用", 409);
    }
    try {
      const clientPasswordHash = current.session.appAudience === "client"
        ? await clientSelfPasswordHash(await getClientAuthPostgresPool(), current.session.tokenHash)
        : null;
      if (current.session.appAudience === "client" && !clientPasswordHash) {
        throw new ResearchApiError("ACCOUNT_NOT_FOUND", "账户不存在或已失效", 404);
      }
      const result = await updateAccountProfile(await getPostgresPool(), {
        userId: current.user.id,
        currentSessionId: current.session.id,
        sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
        currentIdentity: current.session.appAudience === "client" ? {
          username: current.user.username,
          phone: current.user.phone,
          passwordHash: clientPasswordHash!,
        } : undefined,
        currentPassword,
        profile: { username, nickname, avatarUrl, phone, dateOfBirth: dateOfBirth || null, gender, timezone },
      });
      if (!result.ok) {
        const message = result.code === "CURRENT_PASSWORD_INVALID" ? "当前密码不正确" : "账户不存在或已失效";
        throw new ResearchApiError(result.code, message, result.code === "ACCOUNT_NOT_FOUND" ? 404 : 422);
      }
      const updated = current.session.appAudience === "client"
        ? result.user
        : await db.query.users.findFirst({ where: eq(users.id, current.user.id) });
      return Response.json({ ok: true, user: updated ? safeUser(updated) : null, sessionsRevoked: result.otherSessionsRevoked }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && /phone/i.test(error.message) && /unique constraint|duplicate key/i.test(error.message)) throw new ResearchApiError("PHONE_TAKEN", "该手机号已被使用", 409);
      if (error instanceof Error && /unique constraint|duplicate key/i.test(error.message)) throw new ResearchApiError("NAME_TAKEN", "该用户名或昵称已被使用", 409);
      throw error;
    }
  } catch (error) { return responseError(error, request.headers.get("x-request-id") ?? undefined); }
}
