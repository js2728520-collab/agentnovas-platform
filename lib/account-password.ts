import type { Pool } from "pg";

import { hashPassword, verifyPassword } from "./auth.ts";

export async function changeAccountPassword(pool: Pool, input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  now?: Date;
}) {
  if (input.newPassword === input.currentPassword) return { ok: false as const, code: "PASSWORD_REUSE" as const };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = (await client.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1 FOR UPDATE", [input.userId])).rows[0];
    if (!user || !await verifyPassword(input.currentPassword, user.password_hash)) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "CURRENT_PASSWORD_INVALID" as const };
    }
    const now = input.now ?? new Date();
    const passwordHash = await hashPassword(input.newPassword);
    await client.query("UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1", [input.userId, passwordHash, now]);
    await client.query("UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [input.userId, now]);
    await client.query(`
      INSERT INTO audit_logs (
        id, actor_user_id, action, subject_type, subject_id, after_json,
        ip_address, user_agent, created_at
      ) VALUES ($1, $2, 'auth.password_changed', 'user', $2, $3, $4, $5, $6)
    `, [crypto.randomUUID(), input.userId, JSON.stringify({ sessionsRevoked: true }), input.ipAddress ?? null, input.userAgent ?? null, now]);
    await client.query("COMMIT");
    return { ok: true as const };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
