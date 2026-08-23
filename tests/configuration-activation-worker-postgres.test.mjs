import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  CONFIGURATION_ACTIVATION_WORKER_LEASE_KEY,
  runDueConfigurationActivations,
} from "../lib/configuration-activation-worker.ts";
import {
  createConfigurationVersion,
  readConfigurationVersions,
  reviewConfigurationVersion,
  scheduleConfigurationVersion,
  testConfigurationVersion,
} from "../lib/versioned-configuration-service.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `configuration_activation_worker_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
const evidence = (letter) => letter.repeat(64);
let factSequence = 0;

async function scheduledVersion({ key, scheduledFor, now = new Date(Date.now() - 60 * 60_000).toISOString() }) {
  factSequence += 1;
  const suffix = String(factSequence).padStart(4, "0");
  const created = await createConfigurationVersion(pool, {
    actorUserId: "maker",
    idempotencyKey: `worker-create-${suffix}`,
    requestId: `worker-create-${suffix}`,
    version: {
      kind: "prompt",
      key,
      audience: "shared",
      schemaVersion: 1,
      payload: { enabled: true, sequence: factSequence },
      reason: "创建自动激活 Worker PostgreSQL 验证版本",
    },
  });
  await testConfigurationVersion(pool, {
    versionId: created.id,
    actorUserId: "maker",
    idempotencyKey: `worker-test-${suffix}`,
    requestId: `worker-test-${suffix}`,
    test: { result: "passed", evidenceSha256: evidence(String.fromCharCode(96 + factSequence)), reason: "自动激活候选测试证据通过" },
  });
  await reviewConfigurationVersion(pool, {
    versionId: created.id,
    reviewerUserId: "checker",
    idempotencyKey: `worker-review-${suffix}`,
    requestId: `worker-review-${suffix}`,
    approval: { decision: "approve", reason: "独立复核自动激活候选通过" },
  });
  await scheduleConfigurationVersion(pool, {
    versionId: created.id,
    actorUserId: "checker",
    idempotencyKey: `worker-schedule-${suffix}`,
    requestId: `worker-schedule-${suffix}`,
    now: new Date(now),
    schedule: { scheduledFor, reason: "登记自动激活验证时间" },
  });
  return created;
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationOptions = { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "configuration-activation-worker-test" };
  const migrated = await runPostgresMigrations(pool, migrationOptions);
  assert.ok(migrated.applied.includes("0070_configuration_activation_worker.sql"));
  const rerun = await runPostgresMigrations(pool, migrationOptions);
  assert.deepEqual(rerun.applied, []);
  assert.ok(rerun.skipped.includes("0070_configuration_activation_worker.sql"));
  for (const id of ["maker", "checker"]) {
    await pool.query(`INSERT INTO users(id,email,password_hash,role,status) VALUES($1,$2,'test-only-hash','hq_admin','active')`, [id, `${id}@quality.invalid`]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("one leased worker activates only due versions and replay is idempotent", async () => {
  const wallClock = new Date();
  const due = await scheduledVersion({ key: "client.worker_due", scheduledFor: new Date(wallClock.getTime() - 60_000).toISOString() });
  const future = await scheduledVersion({ key: "client.worker_future", scheduledFor: new Date(wallClock.getTime() + 60 * 60_000).toISOString() });
  const leaseHolder = await pool.connect();
  await leaseHolder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [CONFIGURATION_ACTIVATION_WORKER_LEASE_KEY]);
  const blocked = await runDueConfigurationActivations(pool, { now: wallClock, batchSize: 10 });
  assert.deepEqual(blocked, { leaseAcquired: false, scanned: 0, activated: 0, skipped: 0, failed: 0, failures: [] });
  leaseHolder.release(true);

  const processed = await runDueConfigurationActivations(pool, { now: wallClock, batchSize: 10 });
  assert.equal(processed.leaseAcquired, true);
  assert.equal(processed.scanned, 1);
  assert.equal(processed.activated, 1);
  assert.equal(processed.failed, 0);
  const replay = await runDueConfigurationActivations(pool, { now: wallClock, batchSize: 10 });
  assert.equal(replay.activated, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM configuration_activations WHERE configuration_version_id=$1`, [due.id])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM configuration_activations WHERE configuration_version_id=$1`, [future.id])).rows[0].count, 0);
  const activation = (await pool.query(`SELECT actor_kind,actor_user_id,actor_identity,action FROM configuration_activations WHERE configuration_version_id=$1`, [due.id])).rows[0];
  assert.deepEqual(activation, { actor_kind: "worker", actor_user_id: null, actor_identity: "configuration-activation-worker", action: "activate" });
  const projected = (await readConfigurationVersions(pool, { limit: 20, cursor: null })).versions.find((version) => version.id === due.id);
  assert.equal(projected?.activations[0].actorKind, "worker");
  assert.equal(projected?.activations[0].actorIdentity, "configuration-activation-worker");
  assert.equal(projected?.activations[0].actorUserId, null);
});

test("a failed candidate rolls back independently and later due candidates continue", async () => {
  const wallClock = new Date();
  const baseline = await scheduledVersion({ key: "client.worker_failure", scheduledFor: new Date(wallClock.getTime() - 3 * 60_000).toISOString() });
  const baselineRun = await runDueConfigurationActivations(pool, { now: wallClock, batchSize: 10 });
  assert.equal(baselineRun.activated, 1);
  const failed = await scheduledVersion({ key: "client.worker_failure", scheduledFor: new Date(wallClock.getTime() - 2 * 60_000).toISOString() });
  const succeeds = await scheduledVersion({ key: "client.worker_continues", scheduledFor: new Date(wallClock.getTime() - 60_000).toISOString() });
  await pool.query(`CREATE TABLE worker_activation_failure_injection(configuration_version_id text PRIMARY KEY)`);
  await pool.query(`INSERT INTO worker_activation_failure_injection(configuration_version_id) VALUES($1)`, [failed.id]);
  await pool.query(`
    CREATE FUNCTION reject_one_worker_activation() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM worker_activation_failure_injection
         WHERE configuration_version_id=NEW.configuration_version_id
      ) THEN
        RAISE EXCEPTION 'injected worker activation failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`CREATE TRIGGER trg_reject_one_worker_activation BEFORE INSERT ON configuration_activations FOR EACH ROW EXECUTE FUNCTION reject_one_worker_activation()`);

  const processed = await runDueConfigurationActivations(pool, { now: wallClock, batchSize: 10 });
  assert.equal(processed.scanned, 2);
  assert.equal(processed.activated, 1);
  assert.equal(processed.failed, 1);
  assert.deepEqual(processed.failures.map(({ versionId }) => versionId), [failed.id]);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM configuration_activations WHERE configuration_version_id=$1`, [failed.id])).rows[0].count, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM configuration_activations WHERE configuration_version_id=$1`, [succeeds.id])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM audit_logs WHERE subject_id=$1 AND action='configuration.version.activated'`, [failed.id])).rows[0].count, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM audit_logs WHERE subject_id=$1 AND action='configuration.version.activated'`, [succeeds.id])).rows[0].count, 1);
  const versions = (await readConfigurationVersions(pool, { limit: 20, cursor: null })).versions;
  assert.equal(versions.find((version) => version.id === baseline.id)?.isCurrent, true);
  assert.equal(versions.find((version) => version.id === failed.id)?.isCurrent, false);
});
