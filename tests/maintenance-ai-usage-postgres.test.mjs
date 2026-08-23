import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { loadMaintenanceAiUsage } from "../lib/maintenance-ai-usage.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const suffix = `${process.pid}_${Date.now()}`;
const schema = `maintenance_ai_usage_${suffix}`;
const readerRole = `maintenance_ai_usage_reader_${suffix}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
let readerPool;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  assert.match(readerRole, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE ROLE "${readerRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await pool.query(`
    CREATE TABLE organizations (id text PRIMARY KEY,name text NOT NULL);
    CREATE TABLE llm_profile_revisions (
      id text PRIMARY KEY,provider_name text NOT NULL,model_name text NOT NULL
    );
    CREATE TABLE ai_credit_reservations (
      id text PRIMARY KEY,status text NOT NULL,settled_credits numeric(36,0)
    );
    CREATE TABLE customer_attributions (
      id text PRIMARY KEY,customer_id text NOT NULL,status text NOT NULL,branch_id text,
      effective_at text,created_at text NOT NULL
    );
    CREATE TABLE client_ai_inference_requests (
      id text PRIMARY KEY,user_id text NOT NULL,operation text NOT NULL,
      profile_revision_id text NOT NULL,status text NOT NULL,reservation_id text,
      error_code text,input_tokens integer,output_tokens integer,created_at timestamptz NOT NULL
    );
    INSERT INTO organizations VALUES ('org-shanghai','上海分公司');
    INSERT INTO llm_profile_revisions VALUES
      ('revision-a','Fixture Provider','model-a'),
      ('revision-b','Fixture Provider','model-b');
    INSERT INTO customer_attributions VALUES
      ('attr-old','user-a','ended','org-shanghai','2026-01-01','2026-01-01'),
      ('attr-current','user-a','active','org-shanghai','2026-08-01','2026-08-01');
    INSERT INTO ai_credit_reservations VALUES
      ('reservation-success-a','settled',900719925474099312345),
      ('reservation-success-b','settled',7),
      ('reservation-failed','released',NULL),
      ('reservation-cancelled','released',NULL),
      ('reservation-processing','reserved',NULL);
    INSERT INTO client_ai_inference_requests VALUES
      ('success-a','user-a','assistant_message','revision-a','succeeded','reservation-success-a',NULL,10,4,'2026-08-23T00:01:00Z'),
      ('success-b','user-b','strategy_generation','revision-b','succeeded','reservation-success-b',NULL,20,6,'2026-08-24T23:59:59Z'),
      ('failed-a','user-a','assistant_message','revision-a','failed','reservation-failed','PROVIDER_UNAVAILABLE',NULL,NULL,'2026-08-24T10:00:00Z'),
      ('cancelled-a','user-a','assistant_message','revision-a','failed','reservation-cancelled','AI_REQUEST_CANCELLED',NULL,NULL,'2026-08-24T11:00:00Z'),
      ('processing-a','user-b','strategy_generation','revision-b','processing','reservation-processing',NULL,NULL,NULL,'2026-08-24T12:00:00Z');
  `);
  const migration = await readFile(new URL("../postgres/migrations/0074_maintenance_ai_usage_analytics.sql", import.meta.url), "utf8");
  const upgradeStart = migration.indexOf("ALTER TABLE client_ai_inference_requests");
  const viewStart = migration.indexOf("CREATE OR REPLACE VIEW maintenance_ai_usage_events_safe", upgradeStart);
  const viewEnd = migration.indexOf(";", viewStart) + 1;
  assert.ok(upgradeStart >= 0 && viewStart > upgradeStart && viewEnd > viewStart, "usage fact upgrade and safe view exist in migration");
  await pool.query(migration.slice(upgradeStart, viewEnd));
  assert.deepEqual((await pool.query(`
    SELECT id,organization_id,organization_attribution_mode
    FROM client_ai_inference_requests ORDER BY id
  `)).rows, [
    { id: "cancelled-a", organization_id: "org-shanghai", organization_attribution_mode: "legacy_current_backfill" },
    { id: "failed-a", organization_id: "org-shanghai", organization_attribution_mode: "legacy_current_backfill" },
    { id: "processing-a", organization_id: null, organization_attribution_mode: "legacy_unattributed" },
    { id: "success-a", organization_id: "org-shanghai", organization_attribution_mode: "legacy_current_backfill" },
    { id: "success-b", organization_id: null, organization_attribution_mode: "legacy_unattributed" },
  ]);
  await pool.query(`
    REVOKE ALL ON organizations,llm_profile_revisions,ai_credit_reservations,
      customer_attributions,client_ai_inference_requests FROM PUBLIC;
    GRANT USAGE ON SCHEMA "${schema}" TO "${readerRole}";
    GRANT SELECT ON maintenance_ai_usage_events_safe TO "${readerRole}";
  `);
  readerPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 7,
    options: `-c search_path=${schema} -c role=${readerRole}`,
  });
});

test.after(async () => {
  await readerPool?.end();
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.query(`DROP ROLE "${readerRole}"`);
  await admin.end();
});

test("least-privilege Maintenance reader can aggregate the safe view but cannot read raw AI requests", async () => {
  await assert.rejects(
    () => readerPool.query("SELECT * FROM client_ai_inference_requests"),
    /permission denied/,
  );
  const report = await loadMaintenanceAiUsage(
    readerPool,
    { from: "2026-08-23", to: "2026-08-24", timezone: "UTC" },
  );
    assert.deepEqual(report.summary, {
      requestCount: 5,
      succeededCount: 2,
      recordedFailureCount: 1,
      cancelledCount: 1,
      processingCount: 1,
      inputTokens: "30",
      outputTokens: "10",
      settledCredits: "900719925474099312352",
      releasedCount: 2,
      recordedFailureRate: 1 / 3,
      organizationAttribution: {
        capturedAtRequest: 0,
        legacyCurrentBackfill: 3,
        legacyUnattributed: 2,
      },
    });
    assert.equal(report.byDay[0].requestCount, 1);
    assert.equal(report.byDay[1].requestCount, 4);
    assert.equal(report.byOrganization.data.find((row) => row.key === "org-shanghai")?.requestCount, 3);
    assert.equal(report.byOrganization.data.find((row) => row.key === "unattributed")?.requestCount, 2);
    assert.equal(report.byModel.data.find((row) => row.key === "revision-a")?.requestCount, 3);
    assert.ok(report.byUser.data.every((row) => /^USR-[A-F0-9]{12}$/.test(row.key)));
  assert.doesNotMatch(JSON.stringify(report), /user-a|user-b|PROVIDER_UNAVAILABLE|AI_REQUEST_CANCELLED/);
});
