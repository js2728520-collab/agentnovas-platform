import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  createReleaseVersion,
  readReleaseManagement,
  recordReleaseDeployment,
  verifyReleaseVersion,
} from "../lib/release-version-service.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `release_version_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const digest = (letter) => letter.repeat(64);
const sha = (letter) => letter.repeat(40);

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runPostgresMigrations(pool, { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "release-version-test" });
  for (const id of ["maker", "checker"]) {
    await pool.query(`INSERT INTO users(id,email,password_hash,role,status) VALUES($1,$2,'test-only-hash','hq_admin','active')`, [id, `${id}@quality.invalid`]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("release evidence is idempotent, maker-checker and environment ordered", async () => {
  const release = await createReleaseVersion(pool, {
    actorUserId: "maker", idempotencyKey: "release-create-0001", requestId: "request-create-1",
    release: { versionTag: "v1.0.0-beta.1", channel: "beta", commitSha: sha("a"), artifactSha256: digest("b"), migrationVersion: "0041_release_version_management", releaseNotes: "首个可发布商业 Beta 版本，锁定三端与版本证据。", reason: "登记已通过自动 Gate 的候选版本" },
  });
  assert.equal(release.status, "draft");
  assert.equal((await createReleaseVersion(pool, {
    actorUserId: "maker", idempotencyKey: "release-create-0001", requestId: "request-create-1",
    release: { versionTag: "v1.0.0-beta.1", channel: "beta", commitSha: sha("a"), artifactSha256: digest("b"), migrationVersion: "0041_release_version_management", releaseNotes: "首个可发布商业 Beta 版本，锁定三端与版本证据。", reason: "登记已通过自动 Gate 的候选版本" },
  })).id, release.id);

  await assert.rejects(verifyReleaseVersion(pool, {
    releaseVersionId: release.id, reviewerUserId: "maker", idempotencyKey: "release-self-0001", requestId: "request-self-1",
    verification: { decision: "approve", evidenceSha256: digest("c"), reason: "提交人不能复核自己的发布版本" },
  }), (error) => error.code === "SELF_APPROVAL_FORBIDDEN" && error.status === 403);

  await assert.rejects(recordReleaseDeployment(pool, {
    releaseVersionId: release.id, actorUserId: "checker", idempotencyKey: "deploy-unverified-0001", requestId: "request-unverified-1",
    deployment: { environment: "staging", action: "deploy", status: "succeeded", evidenceSha256: digest("d"), reason: "部署前必须存在独立验证证据" },
  }), (error) => error.code === "RELEASE_NOT_VERIFIED" && error.status === 409);

  const verified = await verifyReleaseVersion(pool, {
    releaseVersionId: release.id, reviewerUserId: "checker", idempotencyKey: "release-review-0001", requestId: "request-review-1",
    verification: { decision: "approve", evidenceSha256: digest("c"), ciRunUrl: "https://github.com/example/project/actions/runs/123", reason: "独立核对自动 Gate 与构建摘要一致" },
  });
  assert.equal(verified.status, "verified");

  await assert.rejects(recordReleaseDeployment(pool, {
    releaseVersionId: release.id, actorUserId: "checker", idempotencyKey: "deploy-prod-early-0001", requestId: "request-prod-early-1",
    deployment: { environment: "production", action: "deploy", status: "succeeded", evidenceSha256: digest("d"), reason: "生产前应先完成同版本 staging 验证" },
  }), (error) => error.code === "STAGING_DEPLOYMENT_REQUIRED" && error.status === 409);

  const failed = await recordReleaseDeployment(pool, {
    releaseVersionId: release.id, actorUserId: "checker", idempotencyKey: "deploy-stage-fail-0001", requestId: "request-stage-fail-1",
    deployment: { environment: "staging", action: "deploy", status: "failed", evidenceSha256: digest("d"), reason: "staging 健康检查失败，保留证据但不切换当前版本" },
  });
  assert.equal(failed.status, "failed");
  assert.equal((await readReleaseManagement(pool, { limit: 20, cursor: null })).currentByEnvironment.staging, null);

  await recordReleaseDeployment(pool, {
    releaseVersionId: release.id, actorUserId: "checker", idempotencyKey: "deploy-stage-ok-0001", requestId: "request-stage-ok-1",
    deployment: { environment: "staging", action: "deploy", status: "succeeded", evidenceSha256: digest("e"), reason: "staging smoke、健康与恢复检查全部通过" },
  });
  await recordReleaseDeployment(pool, {
    releaseVersionId: release.id, actorUserId: "checker", idempotencyKey: "deploy-prod-ok-0001", requestId: "request-prod-ok-1",
    deployment: { environment: "production", action: "deploy", status: "succeeded", evidenceSha256: digest("f"), reason: "生产 canary 与健康检查通过，登记成功事实" },
  });
  const current = await readReleaseManagement(pool, { limit: 20, cursor: null });
  assert.equal(current.currentByEnvironment.production?.versionTag, "v1.0.0-beta.1");
  assert.equal(current.releases[0].status, "deployed");

  await assert.rejects(pool.query(`UPDATE release_versions SET release_notes='tampered' WHERE id=$1`, [release.id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM release_deployments WHERE release_version_id=$1`, [release.id]), /immutable/);
});

test("a verified next release supersedes and can roll back to a deployed target", async () => {
  const second = await createReleaseVersion(pool, {
    actorUserId: "maker", idempotencyKey: "release-create-0002", requestId: "request-create-2",
    release: { versionTag: "v1.0.0-beta.2", channel: "beta", commitSha: sha("1"), artifactSha256: digest("2"), migrationVersion: "0041_release_version_management", releaseNotes: "第二个商业 Beta 候选版本，用于验证替代与回滚链。", reason: "登记第二个通过 Gate 的候选版本" },
  });
  await verifyReleaseVersion(pool, {
    releaseVersionId: second.id, reviewerUserId: "checker", idempotencyKey: "release-review-0002", requestId: "request-review-2",
    verification: { decision: "approve", evidenceSha256: digest("3"), reason: "独立核对第二个候选版本全部 Gate" },
  });
  for (const environment of ["staging", "production"]) await recordReleaseDeployment(pool, {
    releaseVersionId: second.id, actorUserId: "checker", idempotencyKey: `deploy-${environment}-ok-0002`, requestId: `request-${environment}-2`,
    deployment: { environment, action: "deploy", status: "succeeded", evidenceSha256: digest(environment === "staging" ? "4" : "5"), reason: `${environment} 环境部署与健康验证通过` },
  });
  const firstId = (await pool.query(`SELECT id FROM release_versions WHERE version_tag='v1.0.0-beta.1'`)).rows[0].id;
  await recordReleaseDeployment(pool, {
    releaseVersionId: firstId, actorUserId: "checker", idempotencyKey: "rollback-prod-0001", requestId: "request-rollback-1",
    deployment: { environment: "production", action: "rollback", status: "succeeded", evidenceSha256: digest("6"), reason: "按恢复手册回滚并验证生产健康状态" },
  });
  const control = await readReleaseManagement(pool, { limit: 20, cursor: null });
  assert.equal(control.currentByEnvironment.production?.versionTag, "v1.0.0-beta.1");
  assert.equal(control.releases.find((item) => item.id === firstId)?.status, "rolled_back");
  assert.equal(control.releases.find((item) => item.id === second.id)?.status, "deployed");
});

test("concurrent registration replays one immutable fact and rejects key reuse with changed input", async () => {
  const input = {
    actorUserId: "maker",
    idempotencyKey: "release-create-concurrent-0003",
    requestId: "request-create-concurrent-3",
    release: {
      versionTag: "v1.0.0-beta.3",
      channel: "beta",
      commitSha: sha("7"),
      artifactSha256: digest("8"),
      migrationVersion: "0041_release_version_management",
      releaseNotes: "第三个候选版本用于验证并发登记只产生一条不可变事实。",
      reason: "并发验证同一幂等命令只登记一次",
    },
  };
  const [first, replay] = await Promise.all([
    createReleaseVersion(pool, input),
    createReleaseVersion(pool, input),
  ]);
  assert.equal(replay.id, first.id);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM release_versions WHERE version_tag=$1`, [input.release.versionTag])).rows[0].count, 1);

  await assert.rejects(createReleaseVersion(pool, {
    ...input,
    release: { ...input.release, releaseNotes: "重复使用同一幂等键但改变了发布说明，必须拒绝。" },
  }), (error) => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH" && error.status === 409);
});
