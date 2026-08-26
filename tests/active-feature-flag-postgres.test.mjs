import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  activateConfigurationVersion,
  createConfigurationVersion,
  reviewConfigurationVersion,
  scheduleConfigurationVersion,
  testConfigurationVersion,
} from "../lib/versioned-configuration-service.ts";
import { runRegisteredConfigurationFamilyTest } from "../lib/configuration-family-registry.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `active_feature_flag_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

async function publish(payload, suffix, now, schemaVersion = 1) {
  const version = await createConfigurationVersion(pool, {
    actorUserId: "maker",
    idempotencyKey: `feature-create-${suffix}`,
    requestId: `feature-create-${suffix}`,
    version: {
      kind: "feature_flag",
      key: "client.strategy_research",
      audience: "client",
      schemaVersion,
      payload,
      reason: `创建策略研究功能开关版本 ${suffix}`,
    },
  });
  const tested = await testConfigurationVersion(pool, {
    versionId: version.id,
    actorUserId: "maker",
    idempotencyKey: `feature-test-${suffix}`,
    requestId: `feature-test-${suffix}`,
    test: { reason: `确定性测试通过 ${suffix}` },
  });
  const expected = runRegisteredConfigurationFamilyTest(version);
  assert.equal(tested.latestTest?.result, expected.result);
  assert.equal(tested.latestTest?.evidenceSha256, expected.evidenceSha256);
  await reviewConfigurationVersion(pool, {
    versionId: version.id,
    reviewerUserId: "checker",
    idempotencyKey: `feature-review-${suffix}`,
    requestId: `feature-review-${suffix}`,
    approval: { decision: "approve", reason: `独立审批功能开关 ${suffix}` },
  });
  await scheduleConfigurationVersion(pool, {
    versionId: version.id,
    actorUserId: "checker",
    idempotencyKey: `feature-schedule-${suffix}`,
    requestId: `feature-schedule-${suffix}`,
    now,
    schedule: { scheduledFor: now.toISOString(), reason: `安排功能开关立即生效 ${suffix}` },
  });
  await activateConfigurationVersion(pool, {
    versionId: version.id,
    actorUserId: "activator",
    idempotencyKey: `feature-activate-${suffix}`,
    requestId: `feature-activate-${suffix}`,
    now,
    activation: { action: "activate", reason: `功能开关到期生效 ${suffix}` },
  });
  return version;
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrations = await runPostgresMigrations(pool, {
    directory: new URL("../postgres/migrations/", import.meta.url),
    commitSha: "active-feature-flag-test",
  });
  assert.ok(migrations.applied.includes("0071_active_feature_flag_consumer.sql"));
  for (const id of ["maker", "checker", "activator"]) {
    await pool.query(`INSERT INTO users(id,email,password_hash,role,status) VALUES($1,$2,'test-only-hash','hq_admin','active')`, [id, `${id}@quality.invalid`]);
  }
});

test("registered feature flag rejects browser-supplied test results and evidence", async () => {
  const version = await createConfigurationVersion(pool, {
    actorUserId: "maker",
    idempotencyKey: "feature-create-forged-test",
    requestId: "feature-create-forged-test",
    version: {
      kind: "feature_flag",
      key: "client.strategy_research",
      audience: "client",
      schemaVersion: 1,
      payload: { enabled: true },
      reason: "验证浏览器不能伪造功能开关测试证据",
    },
  });
  await assert.rejects(
    testConfigurationVersion(pool, {
      versionId: version.id,
      actorUserId: "maker",
      idempotencyKey: "feature-forged-test-evidence",
      requestId: "feature-forged-test-evidence",
      test: {
        result: "passed",
        evidenceSha256: "f".repeat(64),
        reason: "尝试从浏览器提交伪造的测试证据",
      },
    }),
    (error) => error?.code === "CONFIGURATION_FAMILY_TEST_INPUT_INVALID",
  );
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("client gateway returns only the latest current version and follows rollback", async () => {
  const now = new Date();
  const disabled = await publish({ enabled: false }, "a", now);
  let current = await pool.query(`SELECT * FROM configuration_client_active_feature_flag($1)`, ["client.strategy_research"]);
  assert.equal(current.rows[0].configuration_version_id, disabled.id);
  assert.equal(current.rows[0].schema_version, 1);
  assert.deepEqual(current.rows[0].payload_json, { enabled: false });

  const targetedPayload = {
    defaultEnabled: false,
    target: {
      enabled: true,
      organizationIds: ["branch-b", "branch-a", "branch-a"],
      applicationVersions: ["v3.0.0"],
      rolloutPercentage: 25,
      startsAt: "2026-08-24T00:00:00+08:00",
      endsAt: "2026-09-24T00:00:00+08:00",
    },
  };
  const enabled = await publish(targetedPayload, "b", new Date(now.getTime() + 1_000), 2);
  current = await pool.query(`SELECT * FROM configuration_client_active_feature_flag($1)`, ["client.strategy_research"]);
  assert.equal(current.rows[0].configuration_version_id, enabled.id);
  assert.equal(current.rows[0].schema_version, 2);
  assert.deepEqual(current.rows[0].payload_json, {
    defaultEnabled: false,
    target: {
      enabled: true,
      organizationIds: ["branch-a", "branch-b"],
      applicationVersions: ["v3.0.0"],
      rolloutPercentage: 25,
      startsAt: "2026-08-23T16:00:00.000Z",
      endsAt: "2026-09-23T16:00:00.000Z",
    },
  });

  await activateConfigurationVersion(pool, {
    versionId: disabled.id,
    actorUserId: "activator",
    idempotencyKey: "feature-rollback-a",
    requestId: "feature-rollback-a",
    now: new Date(now.getTime() + 2_000),
    activation: { action: "rollback", reason: "回滚到此前已验证的关闭版本" },
  });
  current = await pool.query(`SELECT * FROM configuration_client_active_feature_flag($1)`, ["client.strategy_research"]);
  assert.equal(current.rows[0].configuration_version_id, disabled.id);
  assert.equal(current.rows[0].schema_version, 1);
  assert.deepEqual(current.rows[0].payload_json, { enabled: false });
  assert.deepEqual((await pool.query(`SELECT * FROM configuration_client_active_feature_flag($1)`, ["client.unknown"])).rows, []);
});

test("client gateway revokes PUBLIC and owns no direct Client table grant", async () => {
  const routine = await pool.query(`
    SELECT procedure.prosecdef AS security_definer,
           COALESCE(procedure.proconfig,'{}'::text[]) AS config,
           EXISTS(
             SELECT 1
               FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) AS acl
              WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
           ) AS public_execute
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname=$1 AND procedure.proname='configuration_client_active_feature_flag'
  `, [schema]);
  assert.equal(routine.rows[0].security_definer, true);
  assert.equal(routine.rows[0].public_execute, false);
  assert.ok(routine.rows[0].config.some((value) => value.startsWith("search_path=")));
});
