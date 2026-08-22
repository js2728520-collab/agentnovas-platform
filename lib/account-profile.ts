import type { Pool } from "pg";

import { verifyPassword } from "./auth.ts";
import { mapClientIdentityUser } from "./client-identity-gateway.ts";
import { normalizePhone } from "./phone.ts";
import { ResearchApiError } from "./research-errors.ts";

const syntheticPhoneEmailSuffix = "@unverified.agentnovas.local";

function hasUsableEmail(email: string) {
  const value = email.trim().toLowerCase();
  return Boolean(value) && !value.endsWith(syntheticPhoneEmailSuffix);
}

export function normalizeProfilePhoneUpdate(rawPhone: string, identity: {
  email: string;
  username: string | null;
}) {
  const value = rawPhone.trim();
  if (!value) {
    if (!hasUsableEmail(identity.email) && !identity.username?.trim()) {
      throw new ResearchApiError(
        "LOGIN_IDENTIFIER_REQUIRED",
        "手机号是当前账户唯一可用的登录标识，设置用户名或可用邮箱后才能清除",
        422,
      );
    }
    return null;
  }
  const normalized = normalizePhone(value);
  if (!normalized) {
    throw new ResearchApiError("PROFILE_PHONE_INVALID", "手机号格式不正确", 422);
  }
  return normalized.value;
}

type AccountProfileUpdate = {
  username: string;
  nickname: string;
  avatarUrl: string;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string;
  timezone: string;
};

export async function updateAccountProfile(pool: Pool, input: {
  userId: string;
  currentSessionId: string;
  sessionTokenHash?: string;
  currentIdentity?: { username: string | null; phone: string | null; passwordHash: string };
  currentPassword: string;
  profile: AccountProfileUpdate;
  now?: Date;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = input.sessionTokenHash && input.currentIdentity
      ? {
          username: input.currentIdentity.username,
          phone: input.currentIdentity.phone,
          password_hash: input.currentIdentity.passwordHash,
        }
      : (await client.query<{
      username: string | null;
      phone: string | null;
      password_hash: string;
    }>(`
      SELECT username,phone,password_hash
        FROM users
       WHERE id=$1
       FOR UPDATE
    `, [input.userId])).rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "ACCOUNT_NOT_FOUND" as const };
    }
    const loginIdentifiersChanged = [
      ...(current.username !== (input.profile.username || null) ? ["username" as const] : []),
      ...(current.phone !== input.profile.phone ? ["phone" as const] : []),
    ];
    if (loginIdentifiersChanged.length > 0) {
      const password = input.currentPassword;
      if (password.length < 1 || password.length > 128 || !await verifyPassword(password, current.password_hash)) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "CURRENT_PASSWORD_INVALID" as const };
      }
    }
    const now = input.now ?? new Date();
    if (input.sessionTokenHash) {
      const changed = await client.query<{ user_json: Record<string, unknown>; other_sessions_revoked: number }>(`
        SELECT user_json,other_sessions_revoked FROM client_update_profile(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        )
      `, [input.sessionTokenHash,current.password_hash,input.profile.username,input.profile.nickname,
        input.profile.avatarUrl,input.profile.phone,input.profile.dateOfBirth,input.profile.gender,input.profile.timezone,now]);
      const row = changed.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "ACCOUNT_NOT_FOUND" as const };
      }
      if (loginIdentifiersChanged.length > 0) {
        await client.query(`
          INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at)
          VALUES($1,$2,'account.login_identifiers_changed','user',$2,$3::jsonb,$4)
        `, [crypto.randomUUID(),input.userId,JSON.stringify({ loginIdentifiersChanged,otherSessionsRevoked: row.other_sessions_revoked }),now]);
      }
      await client.query("COMMIT");
      return { ok: true as const,loginIdentifiersChanged,otherSessionsRevoked: row.other_sessions_revoked,user: mapClientIdentityUser(row.user_json) };
    }
    await client.query(`
      UPDATE users
         SET username=$2,nickname=$3,avatar_url=$4,phone=$5,date_of_birth=$6,
             gender=$7,timezone=$8,updated_at=$9
       WHERE id=$1
    `, [input.userId,input.profile.username || null,input.profile.nickname,input.profile.avatarUrl,
      input.profile.phone,input.profile.dateOfBirth,input.profile.gender,input.profile.timezone,now]);
    let otherSessionsRevoked = 0;
    if (loginIdentifiersChanged.length > 0) {
      const revoked = await client.query(`
        UPDATE sessions
           SET revoked_at=$3
         WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL
      `, [input.userId, input.currentSessionId, now]);
      otherSessionsRevoked = revoked.rowCount ?? 0;
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at)
        VALUES($1,$2,'account.login_identifiers_changed','user',$2,$3::jsonb,$4)
      `, [crypto.randomUUID(), input.userId, JSON.stringify({
        loginIdentifiersChanged,
        otherSessionsRevoked,
      }), now]);
    }
    await client.query("COMMIT");
    return { ok: true as const, loginIdentifiersChanged, otherSessionsRevoked };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
