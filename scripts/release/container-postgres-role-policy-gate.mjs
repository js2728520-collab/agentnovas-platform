import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  validatedAbsoluteMountSource,
  validatedContainerName,
  validatedReleaseImage,
} from "./container-release-gate-input.mjs";

const ROLE_POLICY_ENV_PATH = "/run/secrets/agentnovas-migrator.env";
const ROLE_POLICY_SCRIPT = "scripts/release/postgres-role-policy.mjs";
const LOOPBACK_ENTRYPOINT = [
  "const raw = process.env.DATABASE_URL?.trim();",
  "if (!raw) throw new Error('DATABASE_URL is required');",
  "const url = new URL(raw);",
  "url.hostname = '127.0.0.1';",
  "url.port = '5432';",
  "process.env.RELEASE_ROLE_POLICY_DATABASE_URL = url.href;",
  "delete process.env.DATABASE_URL;",
  "await import('./' + process.argv[1]);",
].join("\n");

export function planContainerPostgresRolePolicyGate(input) {
  const targetContainer = validatedContainerName(input?.containerName);
  const targetRuntimeImage = validatedReleaseImage(input?.runtimeImage, "runtime image");
  const targetEnvFile = validatedAbsoluteMountSource(input?.envFile, "env file");
  return Object.freeze({
    executable: "docker",
    args: Object.freeze([
      "run",
      "--rm",
      "--network",
      `container:${targetContainer}`,
      "--mount",
      `type=bind,src=${targetEnvFile},dst=${ROLE_POLICY_ENV_PATH},readonly`,
      targetRuntimeImage,
      "node",
      `--env-file=${ROLE_POLICY_ENV_PATH}`,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      LOOPBACK_ENTRYPOINT,
      ROLE_POLICY_SCRIPT,
    ]),
  });
}

export function runContainerPostgresRolePolicyGate(input, dependencies = {}) {
  const plan = planContainerPostgresRolePolicyGate(input);
  const runner = dependencies.runner ?? spawnSync;
  const result = runner(plan.executable, [...plan.args], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error("container PostgreSQL role-policy command could not start");

  let report;
  if (typeof result.stdout === "string" && result.stdout.trim()) {
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error("container PostgreSQL role-policy command did not return valid JSON");
    }
  }
  if (Array.isArray(report?.findings) && report.findings.length > 0) {
    throw new Error(`container PostgreSQL role-policy reported ${report.findings.length} finding(s)`);
  }
  if (result.status !== 0) {
    throw new Error(`container PostgreSQL role-policy exited with status ${result.status ?? "unknown"}`);
  }
  if (!Array.isArray(report?.findings)) {
    throw new Error("container PostgreSQL role-policy output schema invalid");
  }
  return report;
}

function cliInput(argv) {
  const execute = argv.includes("--execute");
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--execute") continue;
    const match = /^--(container|runtime-image|migrator-env-file)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new Error("arguments invalid");
    values.set(match[1], match[2]);
  }
  if (values.size !== 3) throw new Error("arguments invalid");
  return {
    execute,
    input: {
      containerName: values.get("container"),
      runtimeImage: values.get("runtime-image"),
      envFile: values.get("migrator-env-file"),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { execute, input } = cliInput(process.argv.slice(2));
    const result = execute
      ? runContainerPostgresRolePolicyGate(input)
      : { event: "container_postgres_role_policy_plan", ...planContainerPostgresRolePolicyGate(input) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "container PostgreSQL role-policy failed"}\n`);
    process.exitCode = 1;
  }
}
