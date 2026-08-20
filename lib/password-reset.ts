import type { Pool } from "pg";

export async function consumePasswordReset(pool: Pool, input: {
  tokenHash: string;
  passwordHash: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const token = await client.query<{ id: string; user_id: string; status: string }>(`
      SELECT token.id, token.user_id, user_account.status
      FROM auth_tokens token
      INNER JOIN users user_account ON user_account.id = token.user_id
      WHERE token.token_hash = $1
        AND token.purpose = 'reset_password'
        AND token.used_at IS NULL
        AND token.expires_at > $2
      FOR UPDATE OF token, user_account
    `, [input.tokenHash, nowIso]);
    const row = token.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "INVALID_OR_EXPIRED" as const };
    }
    const accountActivated = row.status === "pending";
    await client.query(`UPDATE auth_tokens SET used_at = $2 WHERE id = $1`, [row.id, nowIso]);
    await client.query(`
      UPDATE users SET
        password_hash = $2,
        status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
        email_verified_at = CASE WHEN status = 'pending' THEN $3 ELSE email_verified_at END,
        updated_at = $3
      WHERE id = $1
    `, [row.user_id, input.passwordHash, nowIso]);
    await client.query(`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id, nowIso]);
    await client.query(`
      INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json, created_at)
      VALUES ($1, $2, $3, 'user', $2, $4, $5)
    `, [
      crypto.randomUUID(), row.user_id,
      accountActivated ? "auth.internal_account_activated" : "auth.password_reset",
      JSON.stringify({ sessionsRevoked: true, accountActivated }), nowIso,
    ]);
    await client.query("COMMIT");
    return { ok: true as const, accountActivated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
