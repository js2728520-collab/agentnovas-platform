import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("target service is default-off and separates deploy TCP from the custodied stop socket", async () => {
  const [script, environment, packageJson] = await Promise.all([
    read("scripts/release-target-gateway.mjs"),
    read("deploy/env/release-target.env.example"),
    read("package.json"),
  ]);
  assert.match(environment, /RELEASE_TARGET_ENABLED=false/);
  assert.match(environment, /REPLACE_OUTSIDE_GIT/);
  assert.match(script, /host !== "127\.0\.0\.1"/);
  assert.match(script, /request\.url !== "\/internal\/restricted-cicd\/deploy"/);
  assert.match(script, /32 \* 1024/);
  assert.match(script, /requestStarts\.length >= 30/);
  assert.match(script, /parseRestrictedCicdWorkflowTargetRequest/);
  assert.doesNotMatch(script, /parseRestrictedCicdTargetRequest/);
  assert.match(script, /verifyRestrictedCicdGithubOidcToken/);
  assert.match(script, /executeRestrictedCicdTargetOperation/);
  assert.match(script, /executeRestrictedCicdTargetStop/);
  assert.match(script, /createSecureServer/);
  assert.match(script, /requestCert: true/);
  assert.match(script, /rejectUnauthorized: true/);
  assert.match(script, /getPeerCertificate/);
  assert.match(script, /TLSv1\.3/);
  assert.doesNotMatch(script, /x-agentnovas-client-cert-sha256/);
  assert.match(script, /computeRestrictedCicdTargetBindingSha256/);
  assert.match(script, /loadRestrictedCicdReceiptTrustPolicy/);
  assert.match(script, /RELEASE_TARGET_HOST_IDENTITY_FILE/);
  assert.match(script, /RELEASE_TARGET_AUDITOR_SHARED_SECRET_FILE/);
  assert.match(script, /listRecoverable/);
  assert.match(script, /database\.listRecoverable/);
  assert.match(script, /listPendingLocalStopBackfills/);
  assert.match(script, /listPendingLocalStopRequests/);
  for (const moduleName of [
    "restricted-cicd-target-engine.ts",
    "restricted-cicd-target-journal.ts",
    "restricted-cicd-target-adapter.ts",
    "restricted-cicd-target.ts",
    "restricted-cicd-github.ts",
    "restricted-cicd-domain.ts",
  ]) assert.match(script, new RegExp(moduleName.replaceAll(".", "\\.")));
  assert.match(script, /must be disjoint/);
  assert.match(script, /recoverOwnedStaleLock/);
  assert.match(script, /listRecoverable/);
  assert.doesNotMatch(script, /randomUUID|String\(process\.pid\)/);
  assert.doesNotMatch(script, /console\.(?:log|error)|oidcToken.*(?:log|write)/);
  assert.match(packageJson, /"service:release-target"/);
});

test("target service has a dedicated host identity, credentials and immutable digest compose override", async () => {
  const [unit, override, adapter] = await Promise.all([
    read("deploy/systemd/agentnovas-release-target.service"),
    read("deploy/container/restricted-cicd.override.yml"),
    read("deploy/env/release-target-adapter.json.example"),
  ]);
  assert.match(unit, /User=agentnovas-release-target/);
  assert.match(unit, /SupplementaryGroups=docker/);
  assert.match(unit, /LoadCredential=release-target-receipt-ed25519\.pem/);
  assert.match(unit, /LoadCredential=release-target-receipt-trust\.json/);
  assert.match(unit, /LoadCredential=release-target-host-identity/);
  assert.match(unit, /LoadCredential=release-target-auditor-shared-secret/);
  assert.match(unit, /LoadCredential=release-target-control-identities\.json/);
  assert.match(unit, /LoadCredential=release-target-control-tls\.key/);
  assert.match(unit, /LoadCredential=release-target-control-ca\.crt/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.doesNotMatch(unit, /ProcSubset=pid/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/agentnovas-release-target \/var\/backups\/agentnovas-release-target/);
  for (const variable of [
    "RIVERTON_CLIENT_IMAGE", "RIVERTON_OPERATIONS_IMAGE", "RIVERTON_MAINTENANCE_IMAGE", "RIVERTON_RUNTIME_IMAGE",
  ]) assert.match(override, new RegExp(`\\$\\{${variable}:\\?`));
  const parsed = JSON.parse(adapter);
  assert.equal(parsed.environment, "staging");
  assert.ok(Object.values(parsed.healthUrls).every((url) => url.startsWith("http://127.0.0.1:")));
});
