import type { Pool } from "pg";

import { dummyVerifyPassword, randomToken, sha256 } from "./auth.ts";
import { encryptNotificationToken } from "./notification-secrets.ts";

export async function queueForgotPasswordRequest(pool: Pick<Pool, "query">, input: {
  email: string;
  now?: Date;
  environment?: Record<string, string | undefined>;
}) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 3600_000).toISOString();
  const token = randomToken();
  const [encryptedToken, tokenHash] = await Promise.all([
    encryptNotificationToken(token, input.environment ?? process.env),
    sha256(token),
    dummyVerifyPassword(input.email),
  ]);
  const payload = JSON.stringify({ encryptedToken, audience: "client", expiresAt });
  const result = await pool.query(`
    WITH target_user AS (
      SELECT id FROM users WHERE email = $1 LIMIT 1
    ), inserted_token AS (
      INSERT INTO auth_tokens (id, user_id, token_hash, purpose, token_audience, expires_at)
      SELECT $2, target_user.id, $3, 'reset_password', 'client', $4
      FROM target_user
      RETURNING user_id
    )
    INSERT INTO notification_deliveries
      (id, user_id, channel, category, template_key, payload_json, scheduled_at)
    SELECT $5, inserted_token.user_id, 'email', 'login_security', 'reset_password', $6, $7
    FROM inserted_token
    RETURNING id
  `, [input.email, crypto.randomUUID(), tokenHash, expiresAt, crypto.randomUUID(), payload, now.toISOString()]);
  return { queued: (result.rowCount ?? 0) === 1 };
}
