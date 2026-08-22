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
  const result = await pool.query<{ queued: boolean }>(`
    SELECT client_queue_password_reset($1,$2,$3,$4,$5,$6,$7) AS queued
  `, [input.email,crypto.randomUUID(),tokenHash,expiresAt,crypto.randomUUID(),payload,now]);
  return { queued: Boolean(result.rows[0]?.queued) };
}
