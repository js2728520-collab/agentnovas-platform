import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyQualityReleaseEvidence } from "../../scripts/quality/quality-release-evidence.mjs";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("release evidence verifier hashes only complete, secret-safe outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentnovas-release-evidence-"));
  try {
    for (const directory of ["quality-e2e", "quality-bundle", "quality-lighthouse"]) {
      await mkdir(join(root, directory));
    }
    await writeJson(join(root, "quality-e2e", "fixture-cleanup.json"), {
      schemaCleanupComplete: true,
      runtimeSecretsRemoved: true,
      externalWritesEnabled: false,
    });
    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: true,
      expectedTests: 8,
      externalWritesEnabled: false,
    });
    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="8" failures="0" skipped="0" errors="0"></testsuites>');
    await writeJson(join(root, "quality-bundle", "report.json"), {
      applications: [{ name: "client", passed: true }, { name: "operations", passed: true }, { name: "maintenance", passed: true }],
    });
    await writeJson(join(root, "quality-lighthouse", "manifest.json"), [
      { url: "http://127.0.0.1:3000/login", isRepresentativeRun: false },
      { url: "http://127.0.0.1:3000/login", isRepresentativeRun: true },
      { url: "http://127.0.0.1:3000/login", isRepresentativeRun: false },
    ]);
    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: true,
      numberOfRuns: 3,
      externalWritesEnabled: false,
    });
    await writeJson(join(root, "quality-lighthouse", "fixture-cleanup.json"), {
      schemaCleanupComplete: true,
      runtimeSecretsRemoved: true,
      lhciWorkingFilesRemoved: true,
      externalWritesEnabled: false,
    });

    const manifest = await verifyQualityReleaseEvidence(root);
    assert.equal(manifest.gates.e2e, "passed");
    assert.equal(manifest.gates.bundle, "passed");
    assert.equal(manifest.gates.lighthouse, "passed");
    assert.equal(manifest.artifacts.length, 7);

    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="8" failures="0" skipped="8" errors="0"></testsuites>');
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /E2E evidence is not one complete passing run/);
    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="8" failures="0" skipped="0" errors="0"></testsuites>');

    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: false,
      expectedTests: 8,
      externalWritesEnabled: false,
    });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /E2E gate did not pass/);
    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: true,
      expectedTests: 8,
      externalWritesEnabled: false,
    });

    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: false,
      numberOfRuns: 3,
      externalWritesEnabled: false,
    });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /Lighthouse gate did not pass/);
    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: true,
      numberOfRuns: 3,
      externalWritesEnabled: false,
    });

    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuite><failure>rc_client_session=raw</failure></testsuite>');
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /failed tests|secret-like material/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release evidence verifier rejects retained runtime secret directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentnovas-release-runtime-"));
  try {
    await mkdir(join(root, "quality-e2e", ".runtime"), { recursive: true });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /runtime secret directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
