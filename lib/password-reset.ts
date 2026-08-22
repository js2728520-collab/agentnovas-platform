import type { Pool } from "pg";
import type { AppAudience } from "./riverton-apps.ts";

export async function consumePasswordReset(pool: Pool, input: {
  tokenHash: string;
  passwordHash: string;
  audience: AppAudience;
  primarySession?: {
    id: string;
    tokenHash: string;
    expiresAt: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  };
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.audience === "client") {
      const consumed = await client.query<{ user_id: string; account_activated: boolean }>(`
        SELECT user_id,account_activated FROM client_consume_password_reset($1,$2,$3)
      `, [input.tokenHash,input.passwordHash,now]);
      const row = consumed.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "INVALID_OR_EXPIRED" as const };
      }
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at)
        VALUES($1,$2,$3,'user',$2,$4,$5)
      `, [
        crypto.randomUUID(),row.user_id,row.account_activated ? "auth.internal_account_activated" : "auth.password_reset",
        JSON.stringify({ sessionsRevoked: true, accountActivated: row.account_activated, appAudience: "client", primarySessionCreated: false }),nowIso,
      ]);
      await client.query("COMMIT");
      return {
        ok: true as const,
        accountActivated: row.account_activated,
        primarySessionCreated: false,
        mfaEnrollmentRequired: false,
      };
    }
    const candidate = await client.query<{ user_id: string }>(`
      SELECT token.user_id
      FROM auth_tokens token
      WHERE token.token_hash = $1
        AND token.purpose = 'reset_password'
        AND token.token_audience = $3
        AND token.used_at IS NULL
        AND token.expires_at::timestamptz > $2::timestamptz
    `, [input.tokenHash, nowIso, input.audience]);
    if (!candidate.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "INVALID_OR_EXPIRED" as const };
    }
    const account = await client.query<{
      status: string; role: string; has_assignment: boolean; has_active_mfa: boolean;
    }>(`
      SELECT user_account.status, user_account.role,
             EXISTS (
               SELECT 1 FROM user_role_assignments AS assignment
               INNER JOIN roles AS role ON role.id = assignment.role_id
               WHERE assignment.user_id = user_account.id
                 AND assignment.application_id = $3
                 AND assignment.status = 'active'
                 AND assignment.effective_at <= $2::timestamptz
                 AND (assignment.expires_at IS NULL OR assignment.expires_at > $2::timestamptz)
                 AND role.status = 'published'
             ) AS has_assignment,
             EXISTS (
               SELECT 1 FROM user_mfa_totp_credentials AS credential
               WHERE credential.user_id = user_account.id AND credential.status = 'active'
             ) AS has_active_mfa
      FROM users user_account
      WHERE user_account.id = $1
      FOR UPDATE OF user_account
    `, [candidate.rows[0].user_id, nowIso, input.audience]);
    const row = account.rows[0];
    const token = await client.query<{ id: string }>(`
      SELECT id FROM auth_tokens
      WHERE token_hash = $1
        AND user_id = $4
        AND purpose = 'reset_password'
        AND token_audience = $3
        AND used_at IS NULL
        AND expires_at::timestamptz > $2::timestamptz
      FOR UPDATE
    `, [input.tokenHash, nowIso, input.audience, candidate.rows[0].user_id]);
    if (!row || !token.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "INVALID_OR_EXPIRED" as const };
    }
    const accountActivated = row.status === "pending";
    const internal = true;
    if (internal && (row.role === "customer" || !row.has_assignment || !input.primarySession)) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "INTERNAL_ACCESS_NOT_READY" as const };
    }
    await client.query(`
      UPDATE auth_tokens SET used_at = $2
      WHERE user_id = $1 AND purpose = 'reset_password' AND used_at IS NULL
    `, [candidate.rows[0].user_id, nowIso]);
    await client.query(`
      UPDATE users SET
        password_hash = $2,
        status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
        email_verified_at = CASE WHEN status = 'pending' THEN $3 ELSE email_verified_at END,
        updated_at = $3
      WHERE id = $1
    `, [candidate.rows[0].user_id, input.passwordHash, nowIso]);
    await client.query(`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [candidate.rows[0].user_id, nowIso]);
    if (internal && input.primarySession) {
      await client.query(`
        INSERT INTO sessions (
          id, user_id, token_hash, app_audience, expires_at, mfa_level,
          last_seen_at, idle_expires_at, absolute_expires_at, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, 'primary', $6, $7, $8, $9, $10)
      `, [
        input.primarySession.id, candidate.rows[0].user_id, input.primarySession.tokenHash, input.audience,
        input.primarySession.expiresAt, nowIso, input.primarySession.idleExpiresAt,
        input.primarySession.absoluteExpiresAt, input.primarySession.ipAddress, input.primarySession.userAgent,
      ]);
    }
    await client.query(`
      INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json, created_at)
      VALUES ($1, $2, $3, 'user', $2, $4, $5)
    `, [
      crypto.randomUUID(), candidate.rows[0].user_id,
      accountActivated ? "auth.internal_account_activated" : "auth.password_reset",
      JSON.stringify({ sessionsRevoked: true, accountActivated, appAudience: input.audience, primarySessionCreated: internal }), nowIso,
    ]);
    await client.query("COMMIT");
    return {
      ok: true as const,
      accountActivated,
      primarySessionCreated: internal,
      mfaEnrollmentRequired: internal && !row.has_active_mfa,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
