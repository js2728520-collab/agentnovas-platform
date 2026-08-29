import os from "node:os";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";

import pg from "pg";

import {
  loadGithubAppPrivateKey,
  parseRestrictedCicdGithubBinding,
} from "../lib/restricted-cicd-github.ts";
import {
  createRestrictedCicdWorkerDatabase,
  runRestrictedCicdReconciliationIteration,
  runRestrictedCicdWorkerIteration,
} from "../lib/restricted-cicd-worker.ts";

if (process.env.RELEASE_ORCHESTRATOR_WORKER_ENABLED !== "true") {
  throw new Error("RELEASE_ORCHESTRATOR_WORKER_ENABLED must be true");
}

const databaseValue = process.env.RELEASE_ORCHESTRATOR_DATABASE_URL?.trim();
if (!databaseValue) throw new Error("RELEASE_ORCHESTRATOR_DATABASE_URL is required");
const databaseUrl = new URL(databaseValue);
if (!(["postgres:", "postgresql:"].includes(databaseUrl.protocol))
  || databaseUrl.username !== "agentnovas_release_worker") {
  throw new Error("RELEASE_ORCHESTRATOR_DATABASE_URL must use the dedicated release worker role");
}

const bindingFile = process.env.RELEASE_ORCHESTRATOR_BINDING_FILE?.trim() ?? "";
if (!path.isAbsolute(bindingFile) || bindingFile.length > 500 || bindingFile.includes("\0")) {
  throw new Error("RELEASE_ORCHESTRATOR_BINDING_FILE must be an absolute path");
}

async function loadBinding(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 32 * 1024) {
      throw new Error("invalid binding file");
    }
    if ((metadata.mode & 0o022) !== 0) throw new Error("writable binding file");
    return parseRestrictedCicdGithubBinding(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    throw new Error("restricted CI/CD binding unavailable");
  }
}

function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = Number(raw ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{2,80}$/.test(error.name)) return error.name;
  return "RESTRICTED_CICD_ITERATION_FAILED";
}

const loadedBinding = await loadBinding(bindingFile);
const privateKeyOverride = process.env.RELEASE_ORCHESTRATOR_APP_PRIVATE_KEY_FILE?.trim();
if (privateKeyOverride && (!path.isAbsolute(privateKeyOverride)
  || privateKeyOverride.length > 500 || privateKeyOverride.includes("\0"))) {
  throw new Error("RELEASE_ORCHESTRATOR_APP_PRIVATE_KEY_FILE must be an absolute path");
}
const binding = privateKeyOverride
  ? { ...loadedBinding, appPrivateKeyFile: privateKeyOverride }
  : loadedBinding;
const privateKey = await loadGithubAppPrivateKey(binding.appPrivateKeyFile);
const intervalMs = boundedInteger(process.env.RELEASE_ORCHESTRATOR_INTERVAL_MS, 30_000, 10_000, 300_000);
const leaseSeconds = boundedInteger(process.env.RELEASE_ORCHESTRATOR_LEASE_SECONDS, 300, 30, 900);
const configuredWorkerId = process.env.RELEASE_ORCHESTRATOR_WORKER_ID?.trim();
const workerId = configuredWorkerId
  || `release-worker-${binding.environment}-${os.hostname().replace(/[^a-z0-9_-]/gi, "-").slice(0, 45)}-${process.pid}`;
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 1,
  application_name: "agentnovas-release-orchestrator",
});
const database = createRestrictedCicdWorkerDatabase(pool);
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  process.stdout.write(`${JSON.stringify({
    event: "release_orchestrator_started",
    workerId,
    environment: binding.environment,
    enabled: true,
  })}\n`);
  while (!stopping) {
    try {
      const reconciliation = await runRestrictedCicdReconciliationIteration(database, binding, privateKey);
      if (reconciliation.outcome !== "idle") {
        process.stdout.write(`${JSON.stringify({ event: "release_orchestrator_iteration", ...reconciliation })}\n`);
      }
      const dispatch = await runRestrictedCicdWorkerIteration(
        database,
        binding,
        privateKey,
        { workerId, leaseSeconds },
      );
      if (dispatch.outcome !== "idle") {
        process.stdout.write(`${JSON.stringify({ event: "release_orchestrator_iteration", ...dispatch })}\n`);
      }
    } catch (error) {
      console.error("Release orchestrator iteration failed", { code: safeCode(error) });
    }
    if (!stopping) await delay(intervalMs);
  }
} finally {
  await pool.end();
}
