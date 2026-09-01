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

test("clean web and runtime images contain compiled workspace packages", async () => {
  const dockerfile = await read("deploy/container/Dockerfile");
  assert.match(dockerfile, /FROM base AS workspace-manifests/);
  assert.match(dockerfile, /COPY packages\/ai-control-plane\/package\.json packages\/ai-control-plane\/package\.json/);
  assert.match(dockerfile, /COPY packages\/ai-control-plane-react\/package\.json packages\/ai-control-plane-react\/package\.json/);
  assert.match(dockerfile, /FROM workspace-manifests AS dependencies/);
  assert.match(dockerfile, /FROM workspace-manifests AS production-dependencies/);
  assert.match(dockerfile, /FROM dependencies AS workspace-packages/);
  assert.match(dockerfile, /RUN npm run build:packages/);
  assert.match(dockerfile, /FROM workspace-packages AS builder/);
  assert.match(
    dockerfile,
    /COPY --from=workspace-packages --chown=node:node \/app\/packages \.\/packages/,
    "the runtime image must receive package dist output from the workspace build stage",
  );
});

test("the local versioned image builder uses the canonical container Dockerfile", async () => {
  const builder = await read("scripts/release/build-container-images.mjs");
  assert.match(builder, /"--file", "deploy\/container\/Dockerfile"/);
  assert.match(builder, /"buildx", "build"/);
  assert.doesNotMatch(builder, /(?:RESEND_API_KEY|DATABASE_URL|MFA_TOTP_ENCRYPTION_KEY)/);
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
  for (const [secret, target] of [
    ["client_env", "client.env"],
    ["operations_env", "operations.env"],
    ["maintenance_env", "maintenance.env"],
    ["notification_env", "notification.env"],
    ["configuration_activation_env", "configuration-activation.env"],
    ["release_orchestrator_staging_env", "release-orchestrator-staging.env"],
    ["release_orchestrator_production_env", "release-orchestrator-production.env"],
    ["release_auditor_staging_env", "release-auditor-staging.env"],
    ["release_auditor_production_env", "release-auditor-production.env"],
    ["release_webhook_env", "release-webhook.env"],
    ["release_identity_verifier_env", "release-identity-verifier.env"],
    ["release_control_env", "release-control.env"],
    ["runtime_env", "runtime.env"],
    ["demo_env", "demo.env"],
    ["migrator_env", "migrator.env"],
  ]) {
    assert.match(
      compose,
      new RegExp(`source: ${secret}\\n\\s+target: ${target.replace(".", "\\.")}`),
      `${secret} must use the filename consumed by node --env-file`,
    );
    assert.match(compose, new RegExp(`--env-file=/run/secrets/${target.replace(".", "\\.")}`));
  }
  const postgresService = compose.split("\n  client:")[0];
  assert.doesNotMatch(postgresService, /networks:\s*\[backplane, egress\]/);
  for (const service of ["notification-worker", "runtime-worker", "demo-worker"]) {
    const match = compose.match(new RegExp(`\\n  ${service}:([\\s\\S]*?)(?=\\n  [a-z][a-z-]+:|\\nsecrets:)`));
    const section = match?.[1] ?? "";
    assert.match(section, /networks:\s*\[backplane, egress\]/, `${service} requires controlled egress`);
  }
  const configurationWorker = compose.match(/\n {2}configuration-activation-worker:([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(configurationWorker, /networks:\s*\[backplane\]/);
  assert.doesNotMatch(configurationWorker, /egress|edge/);
  for (const environment of ["staging", "production"]) {
    const releaseWorker = compose.match(new RegExp(`\\n {2}release-orchestrator-${environment}:([\\s\\S]*?)(?=\\n {2}[a-z][a-z-]+:|\\nsecrets:)`))?.[1] ?? "";
    assert.match(releaseWorker, /profiles:\s*\[restricted-cicd\]/);
    assert.match(releaseWorker, /networks:\s*\[backplane, egress\]/);
    assert.match(releaseWorker, new RegExp(`source: release_orchestrator_${environment}_binding`));
    assert.match(releaseWorker, new RegExp(`source: release_orchestrator_${environment}_app_key`));
    assert.doesNotMatch(releaseWorker, /\bedge\b/);
    const releaseAuditor = compose.match(new RegExp(`\\n {2}release-provider-security-auditor-${environment}:([\\s\\S]*?)(?=\\n {2}[a-z][a-z-]+:|\\nsecrets:)`))?.[1] ?? "";
    assert.match(releaseAuditor, /profiles:\s*\[restricted-cicd\]/);
    assert.match(releaseAuditor, /networks:\s*\[backplane, egress\]/);
    assert.match(releaseAuditor, new RegExp(`source: release_auditor_${environment}_app_key`));
    assert.match(releaseAuditor, new RegExp(`source: release_auditor_${environment}_attestation_key`));
    assert.doesNotMatch(releaseAuditor, /\bedge\b|release-orchestrator-.*-app\.pem/);
  }
  const releaseIngress = compose.match(/\n {2}release-webhook-ingress:([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(releaseIngress, /profiles:\s*\[restricted-cicd\]/);
  assert.match(releaseIngress, /networks:\s*\[backplane, edge\]/);
  assert.match(releaseIngress, /release-webhook-binding\.json/);
  assert.match(releaseIngress, /release-webhook-secret/);
  assert.doesNotMatch(releaseIngress, /\begress\b|release-orchestrator-app\.pem/);
  const releaseIdentityVerifier = compose.match(/\n {2}release-identity-verifier:([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(releaseIdentityVerifier, /profiles:\s*\[restricted-cicd\]/);
  assert.match(releaseIdentityVerifier, /networks:\s*\[backplane\]/);
  assert.match(releaseIdentityVerifier, /release-identity-verifier-webauthn-policy\.json/);
  assert.doesNotMatch(releaseIdentityVerifier, /\bedge\b|\begress\b|ports:/);
  const releaseControl = compose.match(/\n {2}release-control:([\s\S]*?)(?=\n {2}[a-z][a-z-]+:|\nsecrets:)/)?.[1] ?? "";
  assert.match(releaseControl, /profiles:\s*\[restricted-cicd\]/);
  assert.match(releaseControl, /networks:\s*\[backplane\]/);
  assert.doesNotMatch(releaseControl, /WEBAUTHN|\bedge\b|\begress\b|ports:/);
  assert.doesNotMatch(compose, /5432:5432/);
  assert.doesNotMatch(compose, /payment-worker|worker:payment|strategy-research-worker/);
});

test("preview deployment inputs are versioned and isolated from production", async () => {
  const [compose, caddy] = await Promise.all([
    read("deploy/container/compose.preview.yml"),
    read("deploy/container/Caddyfile.preview-snippet"),
  ]);

  assert.match(compose, /^name: agentnovas-riverton-preview$/m);
  for (const [service, host] of [
    ["client", "test.agentnovas.com"],
    ["operations", "ops-test.agentnovas.com"],
    ["maintenance", "main-test.agentnovas.com"],
  ]) {
    const serviceBlock = compose.match(new RegExp(`^  ${service}:([\\s\\S]*?)(?=^  [a-z]|^volumes:)`, "m"))?.[1] ?? "";
    const escapedHost = host.replaceAll(".", "\\.");
    assert.match(serviceBlock, new RegExp(`RIVERTON_APP_HOST: ${escapedHost}`), service);
    assert.match(caddy, new RegExp(`^${escapedHost} \\{`, "m"), host);
    assert.match(caddy, new RegExp(`health_headers \\{[\\s\\S]*?Host ${escapedHost}`, "m"), host);
  }
  for (const resource of ["postgres-data", "backplane", "edge", "egress"]) {
    assert.match(compose, new RegExp(`agentnovas-riverton-preview-${resource}`), resource);
  }
  assert.equal((caddy.match(/import agentnovas_security/g) ?? []).length, 3);
  assert.doesNotMatch(compose + caddy, /(?:PASSWORD|SECRET|API_KEY)\s*[:=]/i);
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
