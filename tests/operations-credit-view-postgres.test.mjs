import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `ops_credit_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY, created_at text NOT NULL);
    CREATE TABLE ai_credit_accounts (id text PRIMARY KEY, user_id text NOT NULL, updated_at timestamptz NOT NULL);
    INSERT INTO users VALUES ('customer-without-account','2026-08-20T00:00:00.000Z');
    INSERT INTO users VALUES ('customer-with-account','2026-08-19T00:00:00.000Z');
    INSERT INTO ai_credit_accounts VALUES ('account-1','customer-with-account','2026-08-21T00:00:00Z');
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("operations credit ordering normalizes legacy user timestamps before coalescing", async () => {
  const route = await readFile(new URL("../app/api/operations/credits/route.ts", import.meta.url), "utf8");
  assert.match(route, /COALESCE\(a\.updated_at,u\.created_at::timestamptz\)/);
  assert.doesNotMatch(route, /COALESCE\(a\.updated_at,u\.created_at\)/);
  const result = await pool.query(`
    SELECT u.id, COALESCE(a.updated_at,u.created_at::timestamptz) AS sort_time
    FROM users u LEFT JOIN ai_credit_accounts a ON a.user_id=u.id
    ORDER BY sort_time DESC,u.id DESC
  `);
  assert.deepEqual(result.rows.map((row) => [row.id, row.sort_time.toISOString()]), [
    ["customer-with-account", "2026-08-21T00:00:00.000Z"],
    ["customer-without-account", "2026-08-20T00:00:00.000Z"],
  ]);
});
