import type { Pool } from "pg";

import { sha256 } from "./auth.ts";
import type { AppAudience } from "./riverton-apps.ts";

export type AuthRateLimitAction = "login" | "register" | "verify_email" | "forgot_password" | "reset_password" | "mfa_verify" | "bootstrap";

type ConsumeInput = {
  action: AuthRateLimitAction;
  audience: AppAudience;
  bucketKeys: string[];
  maxAttempts: number;
  windowSeconds: number;
  blockSeconds: number;
  now?: Date;
};

type ClearInput = Pick<ConsumeInput, "action" | "audience" | "bucketKeys">;

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function bucketHashes(input: ClearInput) {
  const keys = [...new Set(input.bucketKeys.map((key) => key.trim()).filter(Boolean))];
  return Promise.all(keys.map((key) => sha256(`${input.action}:${input.audience}:${key}`)));
}

export async function consumeAuthRateLimit(pool: Pool, input: ConsumeInput) {
  const maxAttempts = positiveInteger(input.maxAttempts, "maxAttempts");
  const windowSeconds = positiveInteger(input.windowSeconds, "windowSeconds");
  const blockSeconds = positiveInteger(input.blockSeconds, "blockSeconds");
  const now = input.now ?? new Date();
  const hashes = await bucketHashes(input);
  if (!hashes.length) return { allowed: true, retryAfterSeconds: 0 };

  const results = await Promise.all(hashes.map(async (bucketKeyHash) => {
    const result = await pool.query<{ attempt_count: number; blocked_until: Date | string | null }>(`
      INSERT INTO auth_rate_limit_buckets (
        id, action, app_audience, bucket_key_hash, window_started_at,
        attempt_count, blocked_until, last_attempt_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $5, $5, $5)
      ON CONFLICT (action, app_audience, bucket_key_hash) DO UPDATE SET
        window_started_at = CASE
          WHEN auth_rate_limit_buckets.window_started_at <= $5 - make_interval(secs => $6)
            THEN $5
          ELSE auth_rate_limit_buckets.window_started_at
        END,
        attempt_count = CASE
          WHEN auth_rate_limit_buckets.window_started_at <= $5 - make_interval(secs => $6)
            THEN 1
          ELSE auth_rate_limit_buckets.attempt_count + 1
        END,
        blocked_until = CASE
          WHEN auth_rate_limit_buckets.blocked_until > $5
            THEN auth_rate_limit_buckets.blocked_until
          WHEN auth_rate_limit_buckets.window_started_at <= $5 - make_interval(secs => $6)
            THEN NULL
          WHEN auth_rate_limit_buckets.attempt_count + 1 > $7
            THEN $5 + make_interval(secs => $8)
          ELSE NULL
        END,
        last_attempt_at = $5,
        updated_at = $5
      RETURNING attempt_count, blocked_until
    `, [
      crypto.randomUUID(), input.action, input.audience, bucketKeyHash, now,
      windowSeconds, maxAttempts, blockSeconds,
    ]);
    const blockedUntil = result.rows[0]?.blocked_until ? new Date(result.rows[0].blocked_until) : null;
    return {
      allowed: !blockedUntil || blockedUntil.getTime() <= now.getTime(),
      retryAfterSeconds: blockedUntil
        ? Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000))
        : 0,
    };
  }));

  return results.reduce((current, result) => result.retryAfterSeconds > current.retryAfterSeconds ? result : current,
    { allowed: true, retryAfterSeconds: 0 });
}

export async function clearAuthRateLimit(pool: Pool, input: ClearInput) {
  const hashes = await bucketHashes(input);
  if (!hashes.length) return;
  await pool.query(`
    DELETE FROM auth_rate_limit_buckets
    WHERE action = $1
      AND app_audience = $2
      AND bucket_key_hash = ANY($3::text[])
  `, [input.action, input.audience, hashes]);
}
