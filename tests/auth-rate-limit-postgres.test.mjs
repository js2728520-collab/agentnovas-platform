import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import {
  clearAuthRateLimit,
  consumeAuthRateLimit,
} from "../lib/auth-rate-limit.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `auth_limit_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` });

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

test("concurrent failed logins are atomically limited and identifiers are stored only as hashes", async () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const attempts = await Promise.all(Array.from({ length: 10 }, () => consumeAuthRateLimit(pool, {
    action: "login",
    audience: "operations",
    bucketKeys: ["identifier:Admin@Example.com"],
    maxAttempts: 3,
    windowSeconds: 900,
    blockSeconds: 900,
    now,
  })));
  assert.equal(attempts.filter((attempt) => attempt.allowed).length, 3);
  assert.equal(attempts.filter((attempt) => !attempt.allowed).length, 7);
  const rows = (await pool.query(`SELECT bucket_key_hash, attempt_count, blocked_until FROM auth_rate_limit_buckets`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_count, 10);
  assert.doesNotMatch(rows[0].bucket_key_hash, /admin|example/i);
  assert.ok(rows[0].blocked_until);
});

test("successful authentication can clear only the intended bucket", async () => {
  await clearAuthRateLimit(pool, {
    action: "login",
    audience: "operations",
    bucketKeys: ["identifier:Admin@Example.com"],
  });
  const count = await pool.query(`SELECT count(*)::int AS count FROM auth_rate_limit_buckets`);
  assert.equal(count.rows[0].count, 0);
});

