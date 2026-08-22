import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { reconcileMembershipAccessTransitions } from "../lib/membership-lifecycle.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `membership_lifecycle_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runPostgresMigrations(pool, { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "membership-lifecycle-test" });
  await pool.query(`INSERT INTO users(id,email,password_hash,role,status,email_verified_at) VALUES('trial-customer','trial@quality.invalid','test-only-hash','customer','active','2026-08-01T00:00:00.000Z')`);
  await pool.query(`
    INSERT INTO memberships(id,customer_id,plan_code,status,starts_at,expires_at,grace_ends_at)
    VALUES('trial-membership','trial-customer','trial_monthly_equivalent','active','2026-08-01T00:00:00.000Z','2026-08-04T00:00:00.000Z','2026-08-05T00:00:00.000Z')
  `);
  await pool.query(`
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,strategy_code,risk_json)
    VALUES('trial-portfolio','trial-membership','trial-customer','ai_conservative','{}'::jsonb)
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("lifecycle reconciliation enters grace once and emits idempotent in-app/email evidence", async () => {
  const first = await reconcileMembershipAccessTransitions(pool, { now: new Date("2026-08-04T12:00:00.000Z") });
  assert.deepEqual(first, { processed: 1, transitioned: 1 });
  assert.equal((await pool.query(`SELECT status FROM memberships WHERE id='trial-membership'`)).rows[0].status, "grace");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM membership_access_events WHERE membership_id='trial-membership' AND event_type='trial_grace_started'`)).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM notification_deliveries WHERE user_id='trial-customer' AND template_key='membership_grace_started'`)).rows[0].count, 2);

  const replay = await reconcileMembershipAccessTransitions(pool, { now: new Date("2026-08-04T12:05:00.000Z") });
  assert.deepEqual(replay, { processed: 0, transitioned: 0 });
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM notification_deliveries WHERE user_id='trial-customer' AND template_key='membership_grace_started'`)).rows[0].count, 2);
});

test("lifecycle reconciliation makes expired portfolios read-only and preserves historical evidence", async () => {
  const result = await reconcileMembershipAccessTransitions(pool, { now: new Date("2026-08-05T00:00:00.000Z") });
  assert.deepEqual(result, { processed: 1, transitioned: 1 });
  assert.equal((await pool.query(`SELECT status FROM memberships WHERE id='trial-membership'`)).rows[0].status, "read_only");
  assert.equal((await pool.query(`SELECT access_status FROM official_paper_portfolios WHERE id='trial-portfolio'`)).rows[0].access_status, "read_only");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM membership_access_events WHERE membership_id='trial-membership' AND event_type='read_only_started'`)).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM notification_deliveries WHERE user_id='trial-customer' AND template_key='membership_read_only'`)).rows[0].count, 2);
});
