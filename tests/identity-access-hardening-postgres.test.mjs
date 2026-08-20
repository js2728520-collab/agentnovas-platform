import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `identity_access_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema}`,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of [
    "0000_business_schema.sql",
    "0015_riverton_three_app_rbac_wallet.sql",
    "0021_identity_access_hardening.sql",
    "0021_identity_access_hardening.sql",
  ]) {
    const migration = await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8");
    await pool.query(migration);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("0021 is idempotent and exposes the required identity tables", async () => {
  const tables = (await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [["auth_rate_limit_buckets", "rbac_revocation_tombstones", "user_mfa_recovery_codes", "user_mfa_totp_credentials"]])).rows;
  assert.deepEqual(tables.map((row) => row.table_name), [
    "auth_rate_limit_buckets",
    "rbac_revocation_tombstones",
    "user_mfa_recovery_codes",
    "user_mfa_totp_credentials",
  ]);
});

test("0021 adds session assurance and assignment-bound scope columns", async () => {
  const columns = (await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'sessions' AND column_name = ANY($1::text[])) OR
        (table_name = 'user_role_assignments' AND column_name = ANY($2::text[]))
      )
    ORDER BY table_name, column_name
  `, [
    ["absolute_expires_at", "idle_expires_at", "last_seen_at", "mfa_level", "mfa_verified_at", "session_version"],
    ["scope_organization_ids_json", "scope_version"],
  ])).rows;
  assert.equal(columns.length, 8);
});

test("0021 seeds commercial maker/checker permissions without reconciliation fallback", async () => {
  const expected = [
    "client.membership.view", "client.membership.order", "client.credits.view", "client.paper.view",
    "ops.membership_orders.view", "ops.membership_orders.evidence", "ops.membership_orders.approve",
    "ops.credits.view", "ops.credits.adjust", "ops.credits.approve",
    "ops.performance_fees.view", "ops.performance_fees.generate", "ops.performance_fees.approve",
    "ops.performance_fees.payment_evidence", "ops.performance_fees.payment_approve",
    "maint.demo_exchanges.view", "maint.demo_exchanges.manage", "maint.demo_exchanges.verify", "maint.demo_exchanges.kill",
  ];
  const rows = await pool.query(`
    SELECT key, application_id, sensitive
    FROM permission_definitions
    WHERE key = ANY($1::text[])
    ORDER BY key
  `, [expected]);
  assert.deepEqual(rows.rows.map((row) => row.key), [...expected].sort());
  assert.ok(rows.rows.filter((row) => /\.(approve|adjust|evidence|generate|manage|verify|kill)$/.test(row.key)).every((row) => row.sensitive));
});
