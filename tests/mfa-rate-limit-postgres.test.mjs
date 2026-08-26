import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  consumeAuthRateLimit,
  mfaChallengeRateLimitBucketKeys,
} from "../lib/auth-rate-limit.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `mfa_limit_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql", "0021_identity_access_hardening.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("rotating primary sessions cannot reset one account's MFA challenge budget", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const attempts = [];
  for (const sessionId of ["session-one", "session-two", "session-three", "session-four"]) {
    attempts.push(await consumeAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: "operations",
      bucketKeys: mfaChallengeRateLimitBucketKeys({
        sessionId,
        userId: "same-user",
        connectionBucketKey: "ip:203.0.113.20",
      }),
      maxAttempts: 3,
      windowSeconds: 600,
      blockSeconds: 900,
      now,
    }));
  }

  assert.deepEqual(attempts.map((attempt) => attempt.allowed), [true, true, true, false]);
  const rows = await pool.query(`SELECT count(*)::int AS count FROM auth_rate_limit_buckets`);
  assert.equal(rows.rows[0].count, 6, "four session buckets plus one shared user and one shared connection bucket");
});

test("different accounts on one abusive connection share the connection budget", async () => {
  const now = new Date("2026-08-23T01:00:00.000Z");
  const attempts = [];
  for (const [index, userId] of ["user-one", "user-two", "user-three", "user-four"].entries()) {
    attempts.push(await consumeAuthRateLimit(pool, {
      action: "mfa_verify",
      audience: "maintenance",
      bucketKeys: mfaChallengeRateLimitBucketKeys({
        sessionId: `maintenance-session-${index}`,
        userId,
        connectionBucketKey: "ip:203.0.113.30",
      }),
      maxAttempts: 3,
      windowSeconds: 600,
      blockSeconds: 900,
      now,
    }));
  }

  assert.deepEqual(attempts.map((attempt) => attempt.allowed), [true, true, true, false]);
});
