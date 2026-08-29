import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRestrictedCicdG7EvidenceManifest,
  computeRestrictedCicdG7SubjectSha256,
  REQUIRED_RESTRICTED_CICD_G7_ASSERTIONS,
  REQUIRED_RESTRICTED_CICD_G7_GATES,
} from "../scripts/release/restricted-cicd-g7-evidence.mjs";

const sha = (letter) => letter.repeat(64);

test("restricted deployment workflow exposes only the frozen dispatch envelope and no long-term secret", async () => {
  const workflow = await readFile(new URL("../.github/workflows/restricted-deployment.yml", import.meta.url), "utf8");
  assert.match(workflow, /^name: Restricted Riverton deployment$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /\b(push|pull_request|schedule|workflow_call):/);
  for (const input of [
    "schema_version", "command_id", "release_version_id", "environment", "action",
    "artifact_manifest_sha256", "environment_generation",
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:$`, "m"));
  }
  assert.equal((workflow.match(/^ {6}[a-z0-9_]+:$/gm) ?? []).length, 7);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github\.run_attempt != 1/);
  assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(workflow, /scripts\/release\/restricted-cicd-workflow-client\.mjs/);
  assert.doesNotMatch(workflow, /secrets\.|ssh|kubectl|docker\s|psql|eval|latest/i);
});

test("G7 manifest hashes machine gate results and requires two distinct approvers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restricted-cicd-g7-test-"));
  try {
    const candidate = {
      commitSha: "a".repeat(40), workflowSha256: sha("b"), providerBindingSha256: sha("c"),
      targetBindingSha256: sha("d"), receiptTrustSha256: sha("e"), auditorTrustSha256: sha("0"),
      migrationRegistrySha256: sha("f"), migrationVersion: "0086_restricted_cicd_auditor_trust",
    };
    const policies = {
      environmentPolicySha256: sha("1"), runnerPolicySha256: sha("2"),
      productionReviewerAllowlistSha256: sha("3"), providerFixtureSha256: sha("4"),
    };
    const subjectSha256 = computeRestrictedCicdG7SubjectSha256(candidate, policies);
    const evidence = [];
    const evidenceBodies = new Map();
    for (const gate of REQUIRED_RESTRICTED_CICD_G7_GATES) {
      const path = join(directory, `${gate}.json`);
      const body = {
        schemaVersion: "2", gate, passed: true, subjectSha256,
        providerFixtureSha256: policies.providerFixtureSha256,
        externalWritesEnabled: false,
        startedAt: "2026-08-27T10:00:00.000Z",
        completedAt: "2026-08-27T10:05:00.000Z",
        assertions: REQUIRED_RESTRICTED_CICD_G7_ASSERTIONS[gate].map((name) => ({ name, passed: true })),
        artifacts: [{ name: `${gate}.tap`, sha256: sha("9"), bytes: 1024 }],
      };
      evidenceBodies.set(gate, body);
      await writeFile(path, `${JSON.stringify(body)}\n`);
      evidence.push({ gate, path });
    }
    const manifest = await buildRestrictedCicdG7EvidenceManifest({
      schemaVersion: "2", candidate, policies,
      approvers: { securityActorId: "security-approver", releaseActorId: "release-approver" },
      generatedAt: "2026-08-27T10:10:00.000Z",
      evidence,
    });
    assert.equal(manifest.schemaVersion, "2");
    assert.equal(manifest.subjectSha256, subjectSha256);
    assert.equal(manifest.evidence.length, REQUIRED_RESTRICTED_CICD_G7_GATES.length);
    assert.ok(manifest.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.match(manifest.g7ManifestSha256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      buildRestrictedCicdG7EvidenceManifest({
        schemaVersion: "2", candidate: manifest.candidate, policies: manifest.policies,
        approvers: { securityActorId: "same-actor", releaseActorId: "same-actor" },
        generatedAt: "2026-08-27T10:10:00.000Z", evidence,
      }),
      /distinct G7 approvers/i,
    );
    await writeFile(evidence[0].path, `${JSON.stringify({ schemaVersion: "1", gate: evidence[0].gate, passed: true })}\n`);
    await assert.rejects(
      buildRestrictedCicdG7EvidenceManifest({
        schemaVersion: "2", candidate: manifest.candidate, policies: manifest.policies,
        approvers: { securityActorId: "security-approver", releaseActorId: "release-approver" },
        generatedAt: "2026-08-27T10:10:00.000Z", evidence,
      }),
      /G7 gate did not pass/i,
    );
    const firstGate = evidence[0].gate;
    const firstBody = evidenceBodies.get(firstGate);
    for (const mutation of [
      { ...firstBody, subjectSha256: sha("8") },
      { ...firstBody, externalWritesEnabled: true },
      { ...firstBody, assertions: firstBody.assertions.slice(1) },
      { ...firstBody, artifacts: [] },
    ]) {
      await writeFile(evidence[0].path, `${JSON.stringify(mutation)}\n`);
      await assert.rejects(
        buildRestrictedCicdG7EvidenceManifest({
          schemaVersion: "2", candidate: manifest.candidate, policies: manifest.policies,
          approvers: { securityActorId: "security-approver", releaseActorId: "release-approver" },
          generatedAt: "2026-08-27T10:10:00.000Z", evidence,
        }),
        /G7 gate did not pass/i,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
