import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "./quality-database-fixture.mjs";
import {
  assertQualitySideEffectsDisabled,
  qualityApplicationPorts,
  qualitySchemaName,
  redactPotentialSecrets,
} from "./quality-policy.mjs";

const DISABLED_EFFECT_ENVIRONMENT = {
  PAYMENT_WORKER_ENABLED: "false",
  PAYMENT_PROVIDER_TESTS_ENABLED: "false",
  NOTIFICATION_WORKER_ENABLED: "false",
  NOTIFICATION_EMAIL_SEND_ENABLED: "false",
  DEMO_EXECUTION_WORKER_ENABLED: "false",
  PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "false",
  PLATFORM_DEMO_VERIFICATION_ENABLED: "false",
  STRATEGY_RESEARCH_ENABLED: "false",
  STRATEGY_RUNTIME_ENABLED: "false",
};

const SCRUBBED_PROVIDER_ENVIRONMENT = {
  RESEND_API_KEY: "",
  RESEND_WEBHOOK_SECRET: "",
  AI_API_KEY: "",
  BOOTSTRAP_ADMIN_PASSWORD: "",
  PAYMENT_PROVIDER_API_KEY: "",
  OKX_API_KEY: "",
  OKX_SECRET_KEY: "",
  OKX_PASSPHRASE: "",
  BINANCE_API_KEY: "",
  BINANCE_SECRET_KEY: "",
  BYBIT_API_KEY: "",
  BYBIT_SECRET_KEY: "",
};

function runtimeSecret() {
  return randomBytes(32).toString("base64url");
}

function cleanupFailureEvidence(error, phase) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80)
    : null;
  return {
    phase,
    name: error instanceof Error ? error.name.slice(0, 80) : "Error",
    code: code || null,
    message: redactPotentialSecrets(error instanceof Error ? error.message : String(error)),
  };
}

export async function resetQualityOutputDirectory({ repositoryRoot, outputDirectory }) {
  const allowedRoot = resolve(repositoryRoot, "outputs");
  const target = resolve(outputDirectory);
  const targetRelativePath = relative(allowedRoot, target);
  if (!targetRelativePath
    || targetRelativePath.startsWith("..")
    || resolve(allowedRoot, targetRelativePath) !== target) {
    throw new Error("Quality output directory must be a child of the repository outputs directory");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export async function resetQualityE2eOutput(options) {
  await resetQualityOutputDirectory(options);
}

export async function finalizeQualityFixtureCleanup({
  outputDirectory,
  runtimeDirectory,
  schema,
  startedAt,
  fixturePrepared,
  gateResult,
  cleanupSchema,
  cleanupEvidence = {},
}) {
  const cleanupFailures = [];
  let schemaCleanupComplete = false;
  let runtimeSecretsRemoved = false;
  try {
    await cleanupSchema();
    schemaCleanupComplete = true;
  } catch (error) {
    cleanupFailures.push(cleanupFailureEvidence(error, "schema"));
  } finally {
    try {
      await rm(runtimeDirectory, { recursive: true, force: true });
      runtimeSecretsRemoved = true;
    } catch (error) {
      cleanupFailures.push(cleanupFailureEvidence(error, "runtime_secrets"));
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "gate-result.json"), JSON.stringify(gateResult, null, 2));
  await writeFile(join(outputDirectory, "fixture-cleanup.json"), JSON.stringify({
    ...cleanupEvidence,
    schema,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    fixturePrepared,
    schemaCleanupComplete,
    runtimeSecretsRemoved,
    cleanupFailures,
    externalWritesEnabled: false,
  }, null, 2));
  if (cleanupFailures.length) {
    throw new Error(`${cleanupFailures.map((failure) => failure.phase).join(" and ")} cleanup failed`);
  }
}

export function createQualityRunEnvironment({
  baseEnvironment = process.env,
  applicationDatabaseUrl,
  outputDirectory,
  runtimeDirectory,
  schema,
}) {
  const serverMode = baseEnvironment.QUALITY_E2E_SERVER_MODE === "development"
    ? "development"
    : "production";
  const encryptionKeys = {
    MFA_TOTP_ENCRYPTION_KEY: runtimeSecret(),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: runtimeSecret(),
    NOTIFICATION_TOKEN_ENCRYPTION_KEY: runtimeSecret(),
    LLM_PROFILE_ENCRYPTION_KEY: runtimeSecret(),
    EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: runtimeSecret(),
  };
  return {
    ...baseEnvironment,
    ...DISABLED_EFFECT_ENVIRONMENT,
    ...SCRUBBED_PROVIDER_ENVIRONMENT,
    ...encryptionKeys,
    NODE_ENV: serverMode,
    DATABASE_URL: applicationDatabaseUrl,
    TEST_DATABASE_URL: applicationDatabaseUrl,
    RESEARCH_DATABASE_URL: applicationDatabaseUrl,
    QUALITY_E2E_OUTPUT_DIR: outputDirectory,
    QUALITY_E2E_RUNTIME_DIR: runtimeDirectory,
    QUALITY_E2E_SCHEMA: schema,
    QUALITY_E2E_SERVER_MODE: serverMode,
    NEXT_TELEMETRY_DISABLED: "1",
    // The test runner is the only local reverse-proxy boundary and always supplies
    // a single loopback X-Forwarded-For hop. Production defaults remain unchanged.
    TRUST_PROXY_HOPS: "1",
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export async function resolveLocalPlaywrightBinary(repositoryRoot) {
  const binary = join(repositoryRoot, "node_modules", ".bin", "playwright");
  try {
    await access(binary);
  } catch {
    throw new Error(
      "@playwright/test is not installed locally; add the approved dev dependency and run npm ci",
    );
  }
  return binary;
}

function spawnPlaywright(binary, args, options) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(binary, ["test", ...args], {
      cwd: options.repositoryRoot,
      env: options.environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
}

export async function runQualityE2e({
  repositoryRoot = process.cwd(),
  args = [],
  environment = process.env,
} = {}) {
  assertQualitySideEffectsDisabled(environment);
  const binary = await resolveLocalPlaywrightBinary(repositoryRoot);
  const outputDirectory = resolve(
    repositoryRoot,
    environment.QUALITY_E2E_OUTPUT_DIR || "outputs/quality-e2e",
  );
  await resetQualityE2eOutput({ repositoryRoot, outputDirectory });
  const runtimeDirectory = join(outputDirectory, ".runtime");
  const runId = environment.QUALITY_E2E_RUN_ID
    || `${Date.now()}_${process.pid}_${randomBytes(4).toString("hex")}`;
  const schema = qualitySchemaName(runId);
  const adminDatabaseUrl = environment.QUALITY_E2E_DATABASE_URL
    || environment.TEST_DATABASE_URL
    || "postgresql://127.0.0.1/postgres";
  const ports = qualityApplicationPorts(environment);
  const baseUrls = Object.fromEntries(
    Object.entries(ports).map(([audience, port]) => [audience, `http://127.0.0.1:${port}`]),
  );
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  let fixture;
  let e2ePassed = false;
  const canonicalRun = args.length === 0;
  const startedAt = new Date();
  try {
    fixture = await prepareQualityDatabaseFixture({
      adminDatabaseUrl,
      schema,
      outputDirectory: runtimeDirectory,
      baseUrls,
    });
    const childEnvironment = createQualityRunEnvironment({
      baseEnvironment: environment,
      applicationDatabaseUrl: fixture.applicationDatabaseUrl,
      outputDirectory,
      runtimeDirectory,
      schema,
    });
    const result = await spawnPlaywright(binary, args, {
      repositoryRoot,
      environment: childEnvironment,
    });
    if (result.code !== 0) {
      throw new Error(`Playwright quality run failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
    }
    e2ePassed = canonicalRun;
    return result;
  } finally {
    await finalizeQualityFixtureCleanup({
      outputDirectory,
      runtimeDirectory,
      schema,
      startedAt,
      fixturePrepared: Boolean(fixture),
      gateResult: {
        passed: e2ePassed,
        expectedTests: 8,
        externalWritesEnabled: false,
      },
      cleanupSchema: () => cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema }),
    });
  }
}
