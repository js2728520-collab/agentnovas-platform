import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createQualityRunEnvironment,
  finalizeQualityFixtureCleanup,
  resetQualityE2eOutput,
  resolveLocalPlaywrightBinary,
} from "../../scripts/quality/quality-e2e-runner.mjs";

test("Playwright quality configuration binds loopback and disables binary screenshots", async () => {
  const configuration = await readFile(new URL("../../playwright.config.ts", import.meta.url), "utf8");
  assert.match(configuration, /next \$\{development \? "dev" : "start"\} -H 127\.0\.0\.1 -p/);
  assert.match(configuration, /screenshot:\s*"off"/);
  assert.doesNotMatch(configuration, /screenshot:\s*"only-on-failure"/);
});

test("Playwright quality runner removes prior screenshots and runtime output", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "agentnovas-quality-output-reset-"));
  const outputDirectory = join(repositoryRoot, "outputs", "quality-e2e");
  try {
    await mkdir(join(outputDirectory, ".runtime"), { recursive: true });
    await writeFile(join(outputDirectory, "mfa-failure.png"), "binary-secret-risk");
    await writeFile(join(outputDirectory, ".runtime", "runtime.json"), "secret");
    await resetQualityE2eOutput({ repositoryRoot, outputDirectory });
    await assert.rejects(() => access(join(outputDirectory, "mfa-failure.png")), /ENOENT/);
    await assert.rejects(() => access(join(outputDirectory, ".runtime")), /ENOENT/);
    assert.ok((await access(outputDirectory)) === undefined);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("quality output reset rejects target and ancestor symlinks without deleting an external canary", async () => {
  for (const symlinkPosition of ["target", "outputs", "nested"]) {
    const repositoryRoot = await mkdtemp(join(tmpdir(), `agentnovas-quality-symlink-${symlinkPosition}-`));
    const externalDirectory = await mkdtemp(join(tmpdir(), `agentnovas-quality-canary-${symlinkPosition}-`));
    try {
      let outputDirectory;
      let externalTarget;
      if (symlinkPosition === "target") {
        await mkdir(join(repositoryRoot, "outputs"));
        outputDirectory = join(repositoryRoot, "outputs", "quality-e2e");
        externalTarget = externalDirectory;
        await symlink(externalDirectory, outputDirectory, "dir");
      } else if (symlinkPosition === "outputs") {
        await symlink(externalDirectory, join(repositoryRoot, "outputs"), "dir");
        outputDirectory = join(repositoryRoot, "outputs", "quality-e2e");
        externalTarget = join(externalDirectory, "quality-e2e");
      } else {
        await mkdir(join(repositoryRoot, "outputs"));
        await symlink(externalDirectory, join(repositoryRoot, "outputs", "redirect"), "dir");
        outputDirectory = join(repositoryRoot, "outputs", "redirect", "quality-e2e");
        externalTarget = join(externalDirectory, "quality-e2e");
      }
      await mkdir(externalTarget, { recursive: true });
      const canary = join(externalTarget, "must-survive.txt");
      await writeFile(canary, "outside-repository");

      await assert.rejects(
        () => resetQualityE2eOutput({ repositoryRoot, outputDirectory }),
        /symbolic link|outside.*repository/i,
      );
      assert.equal(await readFile(canary, "utf8"), "outside-repository");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(externalDirectory, { recursive: true, force: true });
    }
  }
});

test("quality output reset rejects a symlinked repository root and safely creates a missing local target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agentnovas-quality-root-link-"));
  const realRepositoryRoot = join(parent, "real-repository");
  const linkedRepositoryRoot = join(parent, "linked-repository");
  await mkdir(realRepositoryRoot);
  await symlink(realRepositoryRoot, linkedRepositoryRoot, "dir");
  try {
    await assert.rejects(
      () => resetQualityE2eOutput({
        repositoryRoot: linkedRepositoryRoot,
        outputDirectory: join(linkedRepositoryRoot, "outputs", "quality-e2e"),
      }),
      /symbolic link/i,
    );

    const outputDirectory = join(realRepositoryRoot, "outputs", "nested", "quality-e2e");
    await resetQualityE2eOutput({ repositoryRoot: realRepositoryRoot, outputDirectory });
    assert.ok((await access(outputDirectory)) === undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("quality runner derives a fail-closed child environment", () => {
  const environment = createQualityRunEnvironment({
    baseEnvironment: {
      NODE_ENV: "test",
      QUALITY_E2E_SERVER_MODE: "production",
      RESEND_API_KEY: "must-not-reach-the-app",
      RESEND_WEBHOOK_SECRET: "must-not-reach-the-app",
      AI_API_KEY: "must-not-reach-the-app",
      OKX_API_KEY: "must-not-reach-the-app",
      RESEARCH_DATABASE_URL: "postgresql://127.0.0.1/wrong_database",
    },
    applicationDatabaseUrl: "postgresql://127.0.0.1/postgres?options=-csearch_path%3Dquality_e2e_run_123",
    outputDirectory: "/tmp/quality-output",
    runtimeDirectory: "/tmp/quality-runtime",
    schema: "quality_e2e_run_123",
  });
  assert.equal(environment.DATABASE_URL, environment.TEST_DATABASE_URL);
  assert.equal(environment.RESEARCH_DATABASE_URL, environment.DATABASE_URL);
  assert.equal(environment.PAYMENT_WORKER_ENABLED, "false");
  assert.equal(environment.PAYMENT_PROVIDER_TESTS_ENABLED, "false");
  assert.equal(environment.NOTIFICATION_EMAIL_SEND_ENABLED, "false");
  assert.equal(environment.MFA_ENFORCEMENT_ENABLED, "false");
  assert.equal(environment.PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED, "false");
  assert.equal(environment.PLATFORM_DEMO_VERIFICATION_ENABLED, "false");
  assert.equal(environment.RESEND_API_KEY, "");
  assert.equal(environment.RESEND_WEBHOOK_SECRET, "");
  assert.equal(environment.AI_API_KEY, "");
  assert.equal(environment.OKX_API_KEY, "");
  assert.equal(environment.ALL_PROXY, "http://127.0.0.1:9");
  assert.equal(environment.QUALITY_E2E_SERVER_MODE, "production");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(environment.TRUST_PROXY_HOPS, "1");
  assert.equal(environment.CLIENT_PUBLIC_BASE_URL, "https://agentnovas.com:3000");
  assert.equal(environment.OPERATIONS_PUBLIC_BASE_URL, "https://zht.agentnovas.com:3001");
  assert.equal(environment.MAINTENANCE_PUBLIC_BASE_URL, "https://xm.agentnovas.com:3002");
  for (const key of [
    "MFA_TOTP_ENCRYPTION_KEY",
    "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
    "NOTIFICATION_TOKEN_ENCRYPTION_KEY",
    "LLM_PROFILE_ENCRYPTION_KEY",
    "EXCHANGE_CREDENTIAL_ENCRYPTION_KEY",
  ]) assert.ok(environment[key].length >= 32, key);
});

test("quality cleanup removes runtime secrets and records a failed schema drop before rejecting", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "agentnovas-quality-cleanup-"));
  const runtimeDirectory = join(outputDirectory, ".runtime");
  await mkdir(runtimeDirectory);
  await writeFile(join(runtimeDirectory, "runtime.json"), JSON.stringify({ password: "plaintext-must-disappear" }));
  try {
    await assert.rejects(() => finalizeQualityFixtureCleanup({
      outputDirectory,
      runtimeDirectory,
      schema: "quality_e2e_cleanup_failure",
      startedAt: new Date("2026-08-21T00:00:00.000Z"),
      fixturePrepared: true,
      gateResult: { passed: false, expectedTests: 15, externalWritesEnabled: false },
      cleanupSchema: async () => { throw new Error("DROP failed password=plaintext-must-disappear"); },
    }), /schema cleanup failed/i);
    await assert.rejects(() => access(runtimeDirectory), /ENOENT/);
    const cleanup = JSON.parse(await readFile(join(outputDirectory, "fixture-cleanup.json"), "utf8"));
    assert.equal(cleanup.schemaCleanupComplete, false);
    assert.equal(cleanup.runtimeSecretsRemoved, true);
    assert.equal(cleanup.cleanupFailures[0].phase, "schema");
    assert.match(cleanup.cleanupFailures[0].message, /DROP failed/);
    assert.doesNotMatch(JSON.stringify(cleanup), /plaintext-must-disappear/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("quality runner resolves only an installed local Playwright binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-bin-"));
  try {
    await assert.rejects(() => resolveLocalPlaywrightBinary(directory), /@playwright\/test/);
    const binDirectory = join(directory, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const binary = join(binDirectory, "playwright");
    await writeFile(binary, "fixture");
    assert.equal(await resolveLocalPlaywrightBinary(directory), binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
