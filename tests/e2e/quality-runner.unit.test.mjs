import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createQualityRunEnvironment,
  resolveLocalPlaywrightBinary,
} from "../../scripts/quality/quality-e2e-runner.mjs";

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
  assert.equal(environment.NOTIFICATION_EMAIL_SEND_ENABLED, "false");
  assert.equal(environment.PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED, "false");
  assert.equal(environment.RESEND_API_KEY, "");
  assert.equal(environment.RESEND_WEBHOOK_SECRET, "");
  assert.equal(environment.AI_API_KEY, "");
  assert.equal(environment.OKX_API_KEY, "");
  assert.equal(environment.ALL_PROXY, "http://127.0.0.1:9");
  assert.equal(environment.QUALITY_E2E_SERVER_MODE, "production");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(environment.TRUST_PROXY_HOPS, "1");
  for (const key of [
    "MFA_TOTP_ENCRYPTION_KEY",
    "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
    "NOTIFICATION_TOKEN_ENCRYPTION_KEY",
    "LLM_PROFILE_ENCRYPTION_KEY",
    "EXCHANGE_CREDENTIAL_ENCRYPTION_KEY",
  ]) assert.ok(environment[key].length >= 32, key);
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
