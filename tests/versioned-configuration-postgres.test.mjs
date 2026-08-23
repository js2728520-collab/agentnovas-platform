import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  activateConfigurationVersion,
  createConfigurationVersion,
  readConfigurationVersions,
  reviewConfigurationVersion,
  scheduleConfigurationVersion,
  testConfigurationVersion,
} from "../lib/versioned-configuration-service.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `versioned_configuration_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
const evidence = (letter) => letter.repeat(64);

const draft = (key, payload, reason = "创建不可变配置草稿用于发布验证") => ({
  kind: "feature_flag", key, audience: "client", schemaVersion: 1, payload, reason,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationOptions = { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "versioned-configuration-test" };
  await runPostgresMigrations(pool, migrationOptions);
  const rerun = await runPostgresMigrations(pool, migrationOptions);
  assert.deepEqual(rerun.applied, []);
  assert.ok(rerun.skipped.includes("0069_versioned_configuration_framework.sql"));
  for (const id of ["maker", "checker", "activator"]) {
    await pool.query(`INSERT INTO users(id,email,password_hash,role,status) VALUES($1,$2,'test-only-hash','hq_admin','active')`, [id, `${id}@quality.invalid`]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("configuration versions are concurrent, idempotent and immutable", async () => {
  const input = {
    actorUserId: "maker", idempotencyKey: "config-create-concurrent-0001", requestId: "request-create-1",
    version: draft("client.strategy_market", { enabled: false, rollout: 0 }),
  };
  const [first, replay] = await Promise.all([createConfigurationVersion(pool, input), createConfigurationVersion(pool, input)]);
  assert.equal(first.id, replay.id);
  assert.equal(first.versionNumber, 1);
  assert.equal(first.status, "draft");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM configuration_versions WHERE configuration_key=$1`, [input.version.key])).rows[0].count, 1);
  await assert.rejects(createConfigurationVersion(pool, { ...input, version: draft(input.version.key, { enabled: true, rollout: 100 }) }),
    (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH" && error.status === 409);
  await assert.rejects(pool.query(`UPDATE configuration_versions SET reason='tampered' WHERE id=$1`, [first.id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM configuration_versions WHERE id=$1`, [first.id]), /immutable/);
});

test("configuration state machine forbids self approval and activation before its UTC instant", async () => {
  const first = (await readConfigurationVersions(pool, { limit: 20, cursor: null })).versions.find((item) => item.key === "client.strategy_market");
  assert.ok(first);
  const tested = await testConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "maker", idempotencyKey: "config-test-pass-0001", requestId: "request-test-1",
    test: { result: "passed", evidenceSha256: evidence("a"), reason: "沙盒测试与配置预期完全一致" },
  });
  assert.equal(tested.status, "tested");
  assert.equal((await testConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "maker", idempotencyKey: "config-test-pass-0001", requestId: "request-test-1",
    test: { result: "passed", evidenceSha256: evidence("a"), reason: "沙盒测试与配置预期完全一致" },
  })).latestTest?.id, tested.latestTest?.id);
  await assert.rejects(reviewConfigurationVersion(pool, {
    versionId: first.id, reviewerUserId: "maker", idempotencyKey: "config-self-review-0001", requestId: "request-self-1",
    approval: { decision: "approve", reason: "创建者不能批准自己的配置版本" },
  }), (error) => error.code === "SELF_APPROVAL_FORBIDDEN" && error.status === 403);
  const approved = await reviewConfigurationVersion(pool, {
    versionId: first.id, reviewerUserId: "checker", idempotencyKey: "config-review-0001", requestId: "request-review-1",
    approval: { decision: "approve", reason: "独立复核配置差异与沙盒证据通过" },
  });
  assert.equal(approved.status, "approved");
  const scheduled = await scheduleConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "checker", idempotencyKey: "config-schedule-0001", requestId: "request-schedule-1",
    now: new Date("2026-08-23T00:00:00Z"), schedule: { scheduledFor: "2026-08-24T08:00:00+08:00", reason: "安排次日 UTC 零点生效窗口" },
  });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.schedule?.scheduledFor, "2026-08-24T00:00:00.000Z");
  assert.equal((await scheduleConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "checker", idempotencyKey: "config-schedule-0001", requestId: "request-schedule-1",
    now: new Date("2026-08-25T00:00:00Z"), schedule: { scheduledFor: "2026-08-24T08:00:00+08:00", reason: "安排次日 UTC 零点生效窗口" },
  })).schedule?.id, scheduled.schedule?.id, "到期后的调度重放仍返回原事实");
  await assert.rejects(activateConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "activator", idempotencyKey: "config-activate-early-0001", requestId: "request-activate-early-1",
    now: new Date("2026-08-23T23:59:59Z"), activation: { action: "activate", reason: "尚未到期的版本不得提前生效" },
  }), (error) => error.code === "CONFIGURATION_NOT_DUE" && error.status === 409);
  const activationInput = {
    versionId: first.id, actorUserId: "activator", idempotencyKey: "config-activate-0001", requestId: "request-activate-1",
    now: new Date("2026-08-24T00:00:00Z"), activation: { action: "activate", reason: "配置已到期并完成发布前复核" },
  };
  const [active, activationReplay] = await Promise.all([
    activateConfigurationVersion(pool, activationInput),
    activateConfigurationVersion(pool, activationInput),
  ]);
  assert.equal(active.status, "active");
  assert.equal(active.isCurrent, true);
  assert.equal(activationReplay.activations[0].id, active.activations[0].id);
  await assert.rejects(pool.query(`UPDATE configuration_test_results SET reason='tampered' WHERE configuration_version_id=$1`, [first.id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM configuration_approvals WHERE configuration_version_id=$1`, [first.id]), /immutable/);
  await assert.rejects(pool.query(`UPDATE configuration_schedules SET scheduled_for=now() WHERE configuration_version_id=$1`, [first.id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM configuration_activations WHERE configuration_version_id=$1`, [first.id]), /immutable/);
});

test("rollback only targets a tested, approved version that was active in the same stream", async () => {
  const created = await createConfigurationVersion(pool, {
    actorUserId: "maker", idempotencyKey: "config-create-0002", requestId: "request-create-2",
    version: draft("client.strategy_market", { enabled: true, rollout: 25 }, "创建第二个灰度配置版本"),
  });
  assert.equal(created.versionNumber, 2);
  await testConfigurationVersion(pool, {
    versionId: created.id, actorUserId: "maker", idempotencyKey: "config-test-pass-0002", requestId: "request-test-2",
    test: { result: "passed", evidenceSha256: evidence("b"), reason: "第二版灰度规则测试通过" },
  });
  await reviewConfigurationVersion(pool, {
    versionId: created.id, reviewerUserId: "checker", idempotencyKey: "config-review-0002", requestId: "request-review-2",
    approval: { decision: "approve", reason: "独立批准第二版灰度配置" },
  });
  await scheduleConfigurationVersion(pool, {
    versionId: created.id, actorUserId: "checker", idempotencyKey: "config-schedule-0002", requestId: "request-schedule-2",
    now: new Date("2026-08-24T00:00:00Z"), schedule: { scheduledFor: "2026-08-24T00:00:00Z", reason: "立即安排第二版生效" },
  });
  await activateConfigurationVersion(pool, {
    versionId: created.id, actorUserId: "activator", idempotencyKey: "config-activate-0002", requestId: "request-activate-2",
    now: new Date("2026-08-24T00:00:00Z"), activation: { action: "activate", reason: "第二版已到期并正式生效" },
  });
  const versions = (await readConfigurationVersions(pool, { limit: 20, cursor: null })).versions;
  const first = versions.find((item) => item.key === "client.strategy_market" && item.versionNumber === 1);
  assert.equal(first?.status, "superseded");
  const rolledBack = await activateConfigurationVersion(pool, {
    versionId: first.id, actorUserId: "activator", idempotencyKey: "config-rollback-0001", requestId: "request-rollback-1",
    now: new Date("2026-08-24T01:00:00Z"), activation: { action: "rollback", reason: "灰度指标异常，恢复已验证的第一版" },
  });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.isCurrent, true);

  const unrelated = await createConfigurationVersion(pool, {
    actorUserId: "maker", idempotencyKey: "config-create-unrelated-0001", requestId: "request-unrelated-1",
    version: draft("client.other_flag", { enabled: false }),
  });
  await testConfigurationVersion(pool, {
    versionId: unrelated.id, actorUserId: "maker", idempotencyKey: "config-test-unrelated-0001", requestId: "request-test-unrelated-1",
    test: { result: "passed", evidenceSha256: evidence("c"), reason: "无关配置流本身测试通过" },
  });
  await reviewConfigurationVersion(pool, {
    versionId: unrelated.id, reviewerUserId: "checker", idempotencyKey: "config-review-unrelated-0001", requestId: "request-review-unrelated-1",
    approval: { decision: "approve", reason: "无关配置流本身独立审批通过" },
  });
  await assert.rejects(activateConfigurationVersion(pool, {
    versionId: unrelated.id, actorUserId: "activator", idempotencyKey: "config-rollback-invalid-0001", requestId: "request-rollback-invalid-1",
    now: new Date("2026-08-24T01:00:00Z"), activation: { action: "rollback", reason: "未曾生效的版本不能作为回滚目标" },
  }), (error) => error.code === "CONFIGURATION_CURRENT_VERSION_MISSING" && error.status === 409);
});
