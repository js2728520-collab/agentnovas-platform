import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeReleaseDeployment,
  normalizeReleaseRegistration,
  normalizeReleaseVerification,
  safeRuntimeReleaseMetadata,
} from "../lib/release-version-domain.ts";

const commitSha = "a".repeat(40);
const digest = "b".repeat(64);

test("release registration accepts a normalized immutable beta identity", () => {
  assert.deepEqual(normalizeReleaseRegistration({
    versionTag: "v1.0.0-beta.1",
    channel: "beta",
    commitSha: commitSha.toUpperCase(),
    artifactSha256: digest.toUpperCase(),
    migrationVersion: "0041_release_version_management",
    releaseNotes: "首个受邀商业 Beta 构建，包含三端与发布证据控制面。",
    reason: "登记经过本地 Gate 验证的候选版本",
  }), {
    versionTag: "v1.0.0-beta.1",
    channel: "beta",
    commitSha,
    artifactSha256: digest,
    migrationVersion: "0041_release_version_management",
    releaseNotes: "首个受邀商业 Beta 构建，包含三端与发布证据控制面。",
    reason: "登记经过本地 Gate 验证的候选版本",
  });
});
test("release inputs reject malformed identities, URLs and deployment states", () => {
  for (const invalid of ["1.0.0", "v01.0.0", "v1.0", "v1.0.0-"]) {
    assert.throws(() => normalizeReleaseRegistration({
      versionTag: invalid,
      channel: "beta",
      commitSha,
      artifactSha256: digest,
      migrationVersion: "0041_release_version_management",
      releaseNotes: "足够长度的发布说明文本。",
      reason: "足够长度的登记原因文本",
    }), /版本标签/);
  }
  assert.throws(() => normalizeReleaseVerification({ decision: "approve", evidenceSha256: digest, ciRunUrl: "https://evil.invalid/run/1", reason: "独立检查全部发布 Gate" }), /CI 运行地址/);
  assert.throws(() => normalizeReleaseDeployment({ environment: "production", action: "ship", status: "succeeded", evidenceSha256: digest, reason: "完成生产部署并核对健康状态" }), /操作/);
});

test("runtime metadata exposes only normalized release identity", () => {
  assert.deepEqual(safeRuntimeReleaseMetadata({
    RIVERTON_RELEASE_TAG: "v1.0.0-beta.1",
    RIVERTON_COMMIT_SHA: commitSha.toUpperCase(),
    RIVERTON_ARTIFACT_SHA256: digest.toUpperCase(),
    DATABASE_URL: "postgres://secret",
  }), { versionTag: "v1.0.0-beta.1", commitSha, artifactSha256: digest });
  assert.deepEqual(safeRuntimeReleaseMetadata({ DATABASE_URL: "postgres://secret" }), { versionTag: null, commitSha: null, artifactSha256: null });
});
