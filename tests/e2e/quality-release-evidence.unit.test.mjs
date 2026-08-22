import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyQualityReleaseEvidence } from "../../scripts/quality/quality-release-evidence.mjs";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function lighthouseReport({
  fcp = 920,
  interactive = 2_420,
  fetchTime = "2026-08-21T15:31:37.155Z",
  url = "http://127.0.0.1:13000/login",
} = {}) {
  return {
    requestedUrl: url,
    finalUrl: url,
    fetchTime,
    lighthouseVersion: "12.6.1",
    runtimeError: null,
    categories: {
      performance: { score: 0.98 },
      accessibility: { score: 1 },
      "best-practices": { score: 1 },
    },
    audits: {
      "first-contentful-paint": { numericValue: fcp },
      interactive: { numericValue: interactive },
      "largest-contentful-paint": { numericValue: 2_300 },
      "cumulative-layout-shift": { numericValue: 0.01 },
      "total-blocking-time": { numericValue: 10 },
      "resource-summary": { details: { items: [
        { resourceType: "script", transferSize: 100_000 },
        { resourceType: "stylesheet", transferSize: 20_000 },
        { resourceType: "image", transferSize: 50_000 },
      ] } },
    },
  };
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
      cleanupFailures: [],
      externalWritesEnabled: false,
    });
    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: true,
      expectedTests: 12,
      externalWritesEnabled: false,
    });
    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="12" failures="0" skipped="0" errors="0"></testsuites>');
    await writeJson(join(root, "quality-bundle", "report.json"), {
      applications: [{ name: "client", passed: true }, { name: "operations", passed: true }, { name: "maintenance", passed: true }],
    });
    const lighthouseEntries = [];
    const representativeMeasurements = [
      { fcp: 900, interactive: 2_400, fetchTime: "2026-08-21T15:31:13.241Z" },
      { fcp: 920, interactive: 2_420, fetchTime: "2026-08-21T15:31:26.040Z" },
      { fcp: 950, interactive: 2_800, fetchTime: "2026-08-21T15:31:37.155Z" },
    ];
    for (let index = 0; index < 3; index += 1) {
      const jsonPath = join(root, "quality-lighthouse", `report-${index}.json`);
      await writeJson(jsonPath, lighthouseReport(representativeMeasurements[index]));
      lighthouseEntries.push({
        url: "http://127.0.0.1:13000/login",
        jsonPath,
        isRepresentativeRun: index === 1,
        summary: { performance: 0.98, accessibility: 1, "best-practices": 1 },
      });
    }
    await writeJson(join(root, "quality-lighthouse", "manifest.json"), lighthouseEntries);
    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: true,
      numberOfRuns: 3,
      externalWritesEnabled: false,
      auditTargetUrl: "http://127.0.0.1:13000/login",
    });
    await writeJson(join(root, "quality-lighthouse", "fixture-cleanup.json"), {
      schemaCleanupComplete: true,
      runtimeSecretsRemoved: true,
      lhciWorkingFilesRemoved: true,
      cleanupFailures: [],
      externalWritesEnabled: false,
    });

    const manifest = await verifyQualityReleaseEvidence(root);
    assert.equal(manifest.gates.e2e, "passed");
    assert.equal(manifest.gates.bundle, "passed");
    assert.equal(manifest.gates.lighthouse, "passed");
    assert.equal(manifest.artifacts.length, 10);

    await writeFile(join(root, "quality-e2e", "mfa-failure.png"), "opaque screenshot bytes");
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /binary image evidence/i);
    await rm(join(root, "quality-e2e", "mfa-failure.png"));

    await rm(lighthouseEntries[2].jsonPath);
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /Lighthouse.*report|Missing or malformed/i);
    await writeJson(lighthouseEntries[2].jsonPath, lighthouseReport(representativeMeasurements[2]));

    await writeJson(join(root, "quality-lighthouse", "manifest.json"), [
      lighthouseEntries[0], lighthouseEntries[1], { ...lighthouseEntries[2], jsonPath: lighthouseEntries[1].jsonPath },
    ]);
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /three distinct.*reports/i);
    await writeJson(join(root, "quality-lighthouse", "manifest.json"), lighthouseEntries);

    await writeJson(join(root, "quality-e2e", "fixture-cleanup.json"), {
      schemaCleanupComplete: true,
      runtimeSecretsRemoved: true,
      cleanupFailures: [{ phase: "schema", message: "DROP failed" }],
      externalWritesEnabled: false,
    });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /cleanup evidence is incomplete or unsafe/i);
    await writeJson(join(root, "quality-e2e", "fixture-cleanup.json"), {
      schemaCleanupComplete: true,
      runtimeSecretsRemoved: true,
      cleanupFailures: [],
      externalWritesEnabled: false,
    });

    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="12" failures="0" skipped="12" errors="0"></testsuites>');
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /E2E evidence is not one complete passing run/);
    await writeFile(join(root, "quality-e2e", "results.xml"), '<testsuites tests="12" failures="0" skipped="0" errors="0"></testsuites>');

    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: false,
      expectedTests: 12,
      externalWritesEnabled: false,
    });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /E2E gate did not pass/);
    await writeJson(join(root, "quality-e2e", "gate-result.json"), {
      passed: true,
      expectedTests: 12,
      externalWritesEnabled: false,
    });

    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: false,
      numberOfRuns: 3,
      externalWritesEnabled: false,
      auditTargetUrl: "http://127.0.0.1:13000/login",
    });
    await assert.rejects(() => verifyQualityReleaseEvidence(root), /Lighthouse gate did not pass/);
    await writeJson(join(root, "quality-lighthouse", "gate-result.json"), {
      passed: true,
      numberOfRuns: 3,
      externalWritesEnabled: false,
      auditTargetUrl: "http://127.0.0.1:13000/login",
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
