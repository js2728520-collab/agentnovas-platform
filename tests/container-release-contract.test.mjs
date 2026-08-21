import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeReleaseVersion } from "../scripts/release/release-identity.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("release versions use a normalized SemVer tag", () => {
  assert.deepEqual(normalizeReleaseVersion("1.0.0-beta.1"), {
    version: "1.0.0-beta.1",
    versionTag: "v1.0.0-beta.1",
  });
  assert.deepEqual(normalizeReleaseVersion("v2.3.4"), {
    version: "2.3.4",
    versionTag: "v2.3.4",
  });
  assert.throws(() => normalizeReleaseVersion("latest"), /SemVer/);
  assert.throws(() => normalizeReleaseVersion("01.2.3"), /SemVer/);
});

test("Next production builds emit audience-bound standalone artifacts", async () => {
  const source = await read("next.config.ts");
  assert.match(source, /output:\s*["']standalone["']/);
  assert.match(source, /deploymentId/);
  assert.match(source, /generateBuildId/);
  assert.match(source, /RIVERTON_RELEASE_TAG/);
  assert.match(source, /GIT_COMMIT_SHA/);
});

test("container images are pinned, non-root and contain no embedded secrets", async () => {
  const dockerfile = await read("deploy/container/Dockerfile");
  assert.match(dockerfile, /node:22\.21\.1-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /AS web/);
  assert.match(dockerfile, /AS runtime/);
  assert.match(dockerfile, /npm ci --include=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /(?:RESEND_API_KEY|DATABASE_URL|MFA_TOTP_ENCRYPTION_KEY)\s*=/);
});

test("production compose keeps PostgreSQL private and mounts runtime env as secrets", async () => {
  const compose = await read("deploy/container/compose.yml");
  assert.match(compose, /agentnovas-riverton\}-client/);
  assert.match(compose, /agentnovas-riverton\}-operations/);
  assert.match(compose, /agentnovas-riverton\}-maintenance/);
  assert.match(compose, /RIVERTON_RELEASE_VERSION:\?/);
  assert.match(compose, /client_env:/);
  assert.match(compose, /notification_env:/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE/);
  assert.match(compose, /egress:/);
  const postgresService = compose.split("\n  client:")[0];
  assert.doesNotMatch(postgresService, /networks:\s*\[backplane, egress\]/);
  for (const service of ["notification-worker", "runtime-worker", "demo-worker"]) {
    const match = compose.match(new RegExp(`\\n  ${service}:([\\s\\S]*?)(?=\\n  [a-z][a-z-]+:|\\nsecrets:)`));
    const section = match?.[1] ?? "";
    assert.match(section, /networks:\s*\[backplane, egress\]/, `${service} requires controlled egress`);
  }
  assert.doesNotMatch(compose, /5432:5432/);
  assert.doesNotMatch(compose, /payment-worker|worker:payment|strategy-research-worker/);
});

test("version tags publish immutable audience images through the release workflow", async () => {
  const workflow = await read(".github/workflows/container-release.yml");
  assert.match(workflow, /tags:\s*\[?\s*["']v\[0-9\]/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /push:\s*true/);
  assert.match(workflow, /release:identity/);
  assert.match(workflow, /riverton-release-manifest/);
  assert.doesNotMatch(workflow, /agentnovas-riverton-[^\s]+:latest/);
});
