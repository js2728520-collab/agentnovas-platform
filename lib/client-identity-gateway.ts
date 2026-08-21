import type { Pool } from "pg";

import type { sessions, users } from "../db/schema.ts";

export type ClientIdentityUser = typeof users.$inferSelect;
export type ClientIdentitySession = typeof sessions.$inferSelect;

type JsonRecord = Record<string, unknown>;

const stringOrNull = (value: unknown) => value === null || value === undefined ? null : String(value);

export function mapClientIdentityUser(value: JsonRecord): ClientIdentityUser {
  return {
    id: String(value.id),
    email: String(value.email),
    passwordHash: String(value.password_hash),
    emailVerifiedAt: stringOrNull(value.email_verified_at),
    role: String(value.role) as ClientIdentityUser["role"],
    organizationId: stringOrNull(value.organization_id),
    status: String(value.status) as ClientIdentityUser["status"],
    locale: String(value.locale),
    timezone: String(value.timezone),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    reportsToUserId: stringOrNull(value.reports_to_user_id),
    username: stringOrNull(value.username),
    nickname: String(value.nickname),
    avatarUrl: String(value.avatar_url),
    phone: stringOrNull(value.phone),
    dateOfBirth: stringOrNull(value.date_of_birth),
    gender: String(value.gender),
  };
}

export function mapClientIdentitySession(value: JsonRecord): ClientIdentitySession {
  return {
    id: String(value.id),
    userId: String(value.user_id),
    tokenHash: String(value.token_hash),
    expiresAt: String(value.expires_at),
    revokedAt: stringOrNull(value.revoked_at),
    ipAddress: stringOrNull(value.ip_address),
    userAgent: stringOrNull(value.user_agent),
    createdAt: String(value.created_at),
    appAudience: String(value.app_audience) as ClientIdentitySession["appAudience"],
    mfaLevel: String(value.mfa_level) as ClientIdentitySession["mfaLevel"],
    mfaVerifiedAt: stringOrNull(value.mfa_verified_at),
    lastSeenAt: stringOrNull(value.last_seen_at),
    idleExpiresAt: stringOrNull(value.idle_expires_at),
    absoluteExpiresAt: stringOrNull(value.absolute_expires_at),
    sessionVersion: Number(value.session_version),
  };
}

export async function clientLoginIdentity(pool: Pool, input: { phone: string; email: string; username: string }) {
  const result = await pool.query<{
    user_json: JsonRecord;
    has_active_mfa: boolean;
  }>("SELECT user_json,has_active_mfa FROM client_login_identity($1,$2,$3)", [input.phone,input.email,input.username]);
  const row = result.rows[0];
  return row ? { user: mapClientIdentityUser(row.user_json), hasActiveMfa: row.has_active_mfa } : null;
}

export async function clientSessionIdentity(pool: Pool, tokenHash: string, now: Date) {
  const result = await pool.query<{
    user_json: JsonRecord;
    session_json: JsonRecord;
    has_active_mfa: boolean;
  }>("SELECT user_json,session_json,has_active_mfa FROM client_session_identity($1,$2)", [tokenHash, now]);
  const row = result.rows[0];
  return row ? {
    user: mapClientIdentityUser(row.user_json),
    session: mapClientIdentitySession(row.session_json),
    hasActiveMfa: row.has_active_mfa,
  } : null;
}

export async function clientSelfPasswordHash(pool: Pool, tokenHash: string, now = new Date()) {
  const result = await pool.query<{ password_hash: string | null }>(
    "SELECT client_self_password_identity($1,$2) AS password_hash",
    [tokenHash,now],
  );
  return result.rows[0]?.password_hash ?? null;
}
