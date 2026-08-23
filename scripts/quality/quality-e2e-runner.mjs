import { randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  CONFIGURATION_ACTIVATION_WORKER_ENABLED: "false",
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

function childPath(root, target, label, { allowEqual = false } = {}) {
  const targetRelativePath = relative(root, target);
  if ((!allowEqual && !targetRelativePath)
    || targetRelativePath === ".."
    || targetRelativePath.startsWith(`..${sep}`)
    || isAbsolute(targetRelativePath)
    || resolve(root, targetRelativePath) !== target) {
    throw new Error(`${label} must remain inside the repository quality output boundary`);
  }
  return targetRelativePath;
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPathWithoutSymbolicLinks(root, target) {
  const targetRelativePath = childPath(root, target, "Quality output directory", { allowEqual: true });
  let current = root;
  const rootState = await pathState(current);
  if (!rootState) throw new Error("Quality repository root does not exist");
  if (rootState.isSymbolicLink()) {
    throw new Error(`Quality output path may not contain a symbolic link: ${current}`);
  }
  for (const segment of targetRelativePath ? targetRelativePath.split(sep) : []) {
    current = join(current, segment);
    const state = await pathState(current);
    if (!state) return;
    if (state.isSymbolicLink()) {
      throw new Error(`Quality output path may not contain a symbolic link: ${current}`);
    }
  }
}

async function controlledQualityOutputTarget({ repositoryRoot, outputDirectory }) {
  const repositoryPath = resolve(repositoryRoot);
  const allowedRoot = resolve(repositoryPath, "outputs");
  const requestedTarget = resolve(outputDirectory);
  childPath(allowedRoot, requestedTarget, "Quality output directory");
  await assertPathWithoutSymbolicLinks(repositoryPath, requestedTarget);

  const repositoryRealPath = await realpath(repositoryPath);
  let existingAncestor = requestedTarget;
  while (!(await pathState(existingAncestor))) {
    if (existingAncestor === repositoryPath) {
      throw new Error("Quality output path has no existing repository ancestor");
    }
    existingAncestor = dirname(existingAncestor);
  }
  const existingAncestorRealPath = await realpath(existingAncestor);
  childPath(repositoryRealPath, existingAncestorRealPath, "Quality output ancestor", { allowEqual: true });
  const controlledTarget = resolve(
    existingAncestorRealPath,
    relative(existingAncestor, requestedTarget),
  );
  childPath(resolve(repositoryRealPath, "outputs"), controlledTarget, "Quality output directory");
  return { controlledTarget, repositoryPath, repositoryRealPath, requestedTarget };
}

export async function resetQualityOutputDirectory({ repositoryRoot, outputDirectory }) {
  const initial = await controlledQualityOutputTarget({ repositoryRoot, outputDirectory });
  const revalidated = await controlledQualityOutputTarget({ repositoryRoot, outputDirectory });
  if (revalidated.repositoryRealPath !== initial.repositoryRealPath
    || revalidated.controlledTarget !== initial.controlledTarget) {
    throw new Error("Quality output path changed during deletion safety checks");
  }
  await rm(revalidated.controlledTarget, { recursive: true, force: true });
  await mkdir(revalidated.controlledTarget, { recursive: true, mode: 0o700 });
  await assertPathWithoutSymbolicLinks(initial.repositoryPath, initial.requestedTarget);
  const createdTargetRealPath = await realpath(revalidated.controlledTarget);
  if (createdTargetRealPath !== revalidated.controlledTarget) {
    throw new Error("Quality output directory resolved outside its controlled target after creation");
  }
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
  profile = "default",
  runtimeDirectory,
  schema,
}) {
  if (profile !== "default" && profile !== "mfa-on") {
    throw new Error(`Unsupported quality E2E profile: ${profile}`);
  }
  const qualityProfile = profile;
  const serverMode = baseEnvironment.QUALITY_E2E_SERVER_MODE === "development"
    ? "development"
    : "production";
  const ports = qualityApplicationPorts(baseEnvironment);
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
    MFA_ENFORCEMENT_ENABLED: qualityProfile === "mfa-on" ? "true" : "false",
    NODE_ENV: serverMode,
    DATABASE_URL: applicationDatabaseUrl,
    TEST_DATABASE_URL: applicationDatabaseUrl,
    RESEARCH_DATABASE_URL: applicationDatabaseUrl,
    QUALITY_E2E_OUTPUT_DIR: outputDirectory,
    QUALITY_E2E_PROFILE: qualityProfile,
    QUALITY_E2E_RUNTIME_DIR: runtimeDirectory,
    QUALITY_E2E_SCHEMA: schema,
    QUALITY_E2E_SERVER_MODE: serverMode,
    CLIENT_PUBLIC_BASE_URL: `https://agentnovas.com:${ports.client}`,
    OPERATIONS_PUBLIC_BASE_URL: `https://zht.agentnovas.com:${ports.operations}`,
    MAINTENANCE_PUBLIC_BASE_URL: `https://xm.agentnovas.com:${ports.maintenance}`,
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

export async function prepareQualityStandaloneAssets(repositoryRoot) {
  for (const audience of ["client", "operations", "maintenance"]) {
    const buildRoot = join(repositoryRoot, `.next-${audience}`);
    const standaloneRoot = join(buildRoot, "standalone");
    await access(join(standaloneRoot, "server.js"));
    await cp(join(repositoryRoot, "public"), join(standaloneRoot, "public"), {
      recursive: true,
      force: true,
    });
    await cp(join(buildRoot, "static"), join(standaloneRoot, `.next-${audience}`, "static"), {
      recursive: true,
      force: true,
    });
  }
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
  profile = "default",
} = {}) {
  assertQualitySideEffectsDisabled(environment);
  if (profile !== "default" && profile !== "mfa-on") {
    throw new Error(`Unsupported quality E2E profile: ${profile}`);
  }
  const binary = await resolveLocalPlaywrightBinary(repositoryRoot);
  const outputDirectory = resolve(
    repositoryRoot,
    environment.QUALITY_E2E_OUTPUT_DIR || (profile === "mfa-on" ? "outputs/quality-mfa-on" : "outputs/quality-e2e"),
  );
  await resetQualityE2eOutput({ repositoryRoot, outputDirectory });
  if (environment.QUALITY_E2E_SERVER_MODE !== "development") {
    await prepareQualityStandaloneAssets(repositoryRoot);
  }
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
      profile,
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
        expectedTests: profile === "mfa-on" ? 3 : 19,
        externalWritesEnabled: false,
        profile,
      },
      cleanupSchema: () => cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema }),
    });
  }
}
