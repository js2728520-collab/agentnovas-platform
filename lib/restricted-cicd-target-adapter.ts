import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { TargetOperationIdentity } from "./restricted-cicd-domain.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;
const IMAGE_PREFIX = /^(?:[a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const FIXED_SERVICES = [
  "client", "operations", "maintenance", "notification-worker",
  "configuration-activation-worker", "runtime-worker", "demo-worker", "execution",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target adapter binding is not canonicalizable");
}

type ImageName = "client" | "operations" | "maintenance" | "runtime";
type ImageDigests = Record<ImageName, string>;

export type RestrictedCicdDeploymentMaterial = {
  releaseTag: string;
  releaseCommitSha: string;
  imageDigests: ImageDigests;
  migrationSetSha256: string;
  migrationVersion: string;
  hasIrreversibleMigrations: boolean;
};

export type RestrictedCicdTargetFence = {
  ownerEpoch: number;
  ownerIdentitySha256: string;
  assertOwned(): Promise<boolean>;
};

export type RestrictedCicdTargetAdapterConfig = {
  environment: "staging" | "production";
  dockerBinary: string;
  pgRestoreBinary: string;
  dockerConfigDirectory: string;
  composeFile: string;
  composeOverrideFile: string;
  composeProject: string;
  imagePrefix: string;
  secretDirectory: string;
  backupDirectory: string;
  markerFile: string;
  ports: { client: number; operations: number; maintenance: number };
  healthUrls: { client: string; operations: string; maintenance: string };
};

type CommandResult = { stdout: string; stdoutBytes: number };
type CommandRunner = (
  binary: string,
  argumentsList: readonly string[],
  options: { environment: Readonly<Record<string, string>>; timeoutMs: number; stdoutFile?: string },
) => Promise<CommandResult>;

export class RestrictedCicdTargetAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdTargetAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdTargetAdapterError(code, message);
}

function absolute(value: string, field: string) {
  if (!path.isAbsolute(value) || value.length > 500 || value.includes("\0")) {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", `Invalid ${field}`);
  }
  return value;
}

function safePort(value: number) {
  return Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
}

function validateConfig(config: RestrictedCicdTargetAdapterConfig) {
  if ((config.environment !== "staging" && config.environment !== "production")
    || !PROJECT.test(config.composeProject) || !IMAGE_PREFIX.test(config.imagePrefix)
    || !safePort(config.ports.client) || !safePort(config.ports.operations)
    || !safePort(config.ports.maintenance)
    || new Set(Object.values(config.ports)).size !== 3) {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target adapter configuration invalid");
  }
  for (const [field, value] of Object.entries({
    dockerBinary: config.dockerBinary,
    pgRestoreBinary: config.pgRestoreBinary,
    dockerConfigDirectory: config.dockerConfigDirectory,
    composeFile: config.composeFile,
    composeOverrideFile: config.composeOverrideFile,
    secretDirectory: config.secretDirectory,
    backupDirectory: config.backupDirectory,
    markerFile: config.markerFile,
  })) absolute(value, field);
  try {
    for (const [application, url] of Object.entries(config.healthUrls)) {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
        || parsed.pathname !== "/api/health/ready" || parsed.search || parsed.hash
        || parsed.port !== String(config.ports[application as keyof typeof config.ports])) {
        return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target health URL invalid");
      }
    }
  } catch {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target health URL invalid");
  }
  return config;
}

export function parseRestrictedCicdTargetAdapterConfig(value: unknown) {
  const topKeys = [
    "schemaVersion", "environment", "dockerBinary", "pgRestoreBinary", "dockerConfigDirectory", "composeFile",
    "composeOverrideFile", "composeProject", "imagePrefix", "secretDirectory", "backupDirectory",
    "markerFile", "ports", "healthUrls",
  ];
  const applicationKeys = ["client", "operations", "maintenance"];
  if (!isObject(value) || !exactKeys(value, topKeys) || value.schemaVersion !== "1"
    || !isObject(value.ports) || !exactKeys(value.ports, applicationKeys)
    || !isObject(value.healthUrls) || !exactKeys(value.healthUrls, applicationKeys)
    || !Object.values(value.ports).every((port) => Number.isSafeInteger(port))
    || !Object.values(value.healthUrls).every((url) => typeof url === "string")
    || ![
      "environment", "dockerBinary", "pgRestoreBinary", "dockerConfigDirectory", "composeFile", "composeOverrideFile",
      "composeProject", "imagePrefix", "secretDirectory", "backupDirectory", "markerFile",
    ].every((key) => typeof value[key] === "string")) {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target adapter configuration invalid");
  }
  return validateConfig({
    environment: value.environment as "staging" | "production",
    dockerBinary: value.dockerBinary as string,
    pgRestoreBinary: value.pgRestoreBinary as string,
    dockerConfigDirectory: value.dockerConfigDirectory as string,
    composeFile: value.composeFile as string,
    composeOverrideFile: value.composeOverrideFile as string,
    composeProject: value.composeProject as string,
    imagePrefix: value.imagePrefix as string,
    secretDirectory: value.secretDirectory as string,
    backupDirectory: value.backupDirectory as string,
    markerFile: value.markerFile as string,
    ports: value.ports as RestrictedCicdTargetAdapterConfig["ports"],
    healthUrls: value.healthUrls as RestrictedCicdTargetAdapterConfig["healthUrls"],
  });
}

export function computeRestrictedCicdTargetBindingSha256(
  configuration: RestrictedCicdTargetAdapterConfig,
  controlIdentityConfigSha256: string | null = null,
  targetInstanceConfigSha256: string | null = null,
) {
  const config = validateConfig(configuration);
  if (controlIdentityConfigSha256 !== null && !SHA256.test(controlIdentityConfigSha256)) {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target control identity binding invalid");
  }
  if (targetInstanceConfigSha256 !== null && !SHA256.test(targetInstanceConfigSha256)) {
    return fail("TARGET_ADAPTER_CONFIG_INVALID", "Target instance binding invalid");
  }
  return createHash("sha256").update(canonicalJson({
    kind: "restricted_cicd_target_binding",
    schemaVersion: "1",
    adapterContractVersion: "1",
    config,
    controlIdentityConfigSha256,
    targetInstanceConfigSha256,
    fixedServices: FIXED_SERVICES,
  })).digest("hex");
}

function validateMaterial(material: RestrictedCicdDeploymentMaterial) {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(material.releaseTag)
    || !/^[a-f0-9]{40}$/.test(material.releaseCommitSha)
    || !Object.values(material.imageDigests).every((digest) => SHA256.test(digest))
    || !SHA256.test(material.migrationSetSha256)
    || !/^[0-9]{4}_[a-z0-9_]{3,96}$/.test(material.migrationVersion)
    || typeof material.hasIrreversibleMigrations !== "boolean") {
    return fail("TARGET_DEPLOYMENT_MATERIAL_INVALID", "Target deployment material invalid");
  }
  return material;
}

function imageReferences(config: RestrictedCicdTargetAdapterConfig, material: RestrictedCicdDeploymentMaterial) {
  return Object.fromEntries(Object.entries(material.imageDigests).map(([name, digest]) => [
    name,
    `${config.imagePrefix}-${name}@sha256:${digest}`,
  ])) as Record<ImageName, string>;
}

function commandEnvironment(
  config: RestrictedCicdTargetAdapterConfig,
  identity: TargetOperationIdentity,
  material: RestrictedCicdDeploymentMaterial,
) {
  const images = imageReferences(config, material);
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    NODE_ENV: "production",
    DOCKER_CONFIG: config.dockerConfigDirectory,
    RIVERTON_RELEASE_VERSION: material.releaseTag.slice(1),
    RIVERTON_COMMIT_SHA: material.releaseCommitSha,
    RIVERTON_ARTIFACT_SHA256: identity.artifactManifestSha256,
    RIVERTON_SECRET_DIR: config.secretDirectory,
    RIVERTON_CLIENT_PORT: String(config.ports.client),
    RIVERTON_OPERATIONS_PORT: String(config.ports.operations),
    RIVERTON_MAINTENANCE_PORT: String(config.ports.maintenance),
    RIVERTON_CLIENT_IMAGE: images.client,
    RIVERTON_OPERATIONS_IMAGE: images.operations,
    RIVERTON_MAINTENANCE_IMAGE: images.maintenance,
    RIVERTON_RUNTIME_IMAGE: images.runtime,
  });
}

async function commandRunner(
  binary: string,
  argumentsList: readonly string[],
  options: { environment: Readonly<Record<string, string>>; timeoutMs: number; stdoutFile?: string },
): Promise<CommandResult> {
  if (options.timeoutMs < 1_000 || options.timeoutMs > 15 * 60_000) {
    return fail("TARGET_COMMAND_INVALID", "Target command timeout invalid");
  }
  const outputHandle = options.stdoutFile ? await open(options.stdoutFile, "wx", 0o600) : null;
  return new Promise((resolve, reject) => {
    const childEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "production", ...options.environment };
    const child = spawn(binary, [...argumentsList], {
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let writeChain = Promise.resolve();
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (outputHandle) {
        child.stdout.pause();
        writeChain = writeChain
          .then(() => outputHandle.write(chunk))
          .then(() => { child.stdout.resume(); })
          .catch(() => { child.kill("SIGKILL"); });
      }
      else if (stdoutBytes <= 256 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("error", async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await writeChain;
      if (outputHandle) await outputHandle.close().catch(() => undefined);
      if (options.stdoutFile) await unlink(options.stdoutFile).catch(() => undefined);
      reject(new RestrictedCicdTargetAdapterError("TARGET_COMMAND_FAILED", "Target command failed"));
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await writeChain;
      if (outputHandle) {
        await outputHandle.sync().catch(() => undefined);
        await outputHandle.close().catch(() => undefined);
      }
      if (code !== 0 || (!outputHandle && stdoutBytes > 256 * 1024)) {
        if (options.stdoutFile) await unlink(options.stdoutFile).catch(() => undefined);
        reject(new RestrictedCicdTargetAdapterError("TARGET_COMMAND_FAILED", "Target command failed"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stdoutBytes });
    });
  });
}

async function atomicMarker(filePath: string, value: unknown) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function createRestrictedCicdTargetAdapter(
  configuration: RestrictedCicdTargetAdapterConfig,
  dependencies: { run?: CommandRunner; fetchImpl?: typeof fetch } = {},
) {
  const config = validateConfig(configuration);
  const run = dependencies.run ?? commandRunner;
  const compose = [
    "compose", "--project-name", config.composeProject,
    "--file", config.composeFile, "--file", config.composeOverrideFile,
  ] as const;

  async function assertCustody() {
    for (const [target, kind] of [
      [config.dockerBinary, "file"], [config.pgRestoreBinary, "file"],
      [config.composeFile, "file"], [config.composeOverrideFile, "file"],
      [config.dockerConfigDirectory, "directory"], [config.secretDirectory, "directory"],
      [config.backupDirectory, "directory"], [path.dirname(config.markerFile), "directory"],
    ] as const) {
      const metadata = await lstat(target);
      if ((kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) || metadata.isSymbolicLink()
        || (metadata.mode & 0o022) !== 0) {
        return fail("TARGET_ADAPTER_CUSTODY_INVALID", "Target adapter custody invalid");
      }
    }
    for (const directory of [config.dockerConfigDirectory, config.backupDirectory, path.dirname(config.markerFile)]) {
      const metadata = await lstat(directory);
      if ((metadata.mode & 0o077) !== 0) {
        return fail("TARGET_ADAPTER_CUSTODY_INVALID", "Target private directory custody invalid");
      }
    }
    const secretMetadata = await lstat(config.secretDirectory);
    if ((secretMetadata.mode & 0o027) !== 0) {
      return fail("TARGET_ADAPTER_CUSTODY_INVALID", "Target secret directory custody invalid");
    }
  }

  async function readMarker() {
    try {
      const metadata = await lstat(config.markerFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 64 * 1024
        || (metadata.mode & 0o077) !== 0) return fail("TARGET_MARKER_INVALID", "Target marker invalid");
      const marker = JSON.parse(await readFile(config.markerFile, "utf8")) as Record<string, unknown>;
      if (!isObject(marker) || marker.schemaVersion !== "1" || marker.environment !== config.environment
        || typeof marker.operationId !== "string" || !IDENTIFIER.test(marker.operationId)
        || typeof marker.releaseVersionId !== "string" || !IDENTIFIER.test(marker.releaseVersionId)
        || !Number.isSafeInteger(marker.ownerEpoch) || Number(marker.ownerEpoch) < 1
        || typeof marker.ownerIdentitySha256 !== "string" || !SHA256.test(marker.ownerIdentitySha256)
        || !isObject(marker.imageDigests)
        || !Object.values(marker.imageDigests).every((digest) => typeof digest === "string" && SHA256.test(digest))) {
        return fail("TARGET_MARKER_INVALID", "Target marker invalid");
      }
      return marker;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function inspectDesiredImages(
    identity: TargetOperationIdentity,
    materialInput: RestrictedCicdDeploymentMaterial,
  ) {
    const material = validateMaterial(materialInput);
    const environment = commandEnvironment(config, identity, material);
    const references = imageReferences(config, material);
    for (const name of Object.keys(references) as ImageName[]) {
      await run(config.dockerBinary, ["pull", references[name]], { environment, timeoutMs: 5 * 60_000 });
      const inspected = await run(config.dockerBinary, [
        "image", "inspect", "--format={{json .}}", references[name],
      ], { environment, timeoutMs: 30_000 });
      const image = JSON.parse(inspected.stdout) as {
        RepoDigests?: unknown;
        Config?: { Labels?: Record<string, unknown> };
      };
      if (!Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(references[name])
        || image.Config?.Labels?.["org.opencontainers.image.version"] !== material.releaseTag
        || image.Config?.Labels?.["org.opencontainers.image.revision"] !== material.releaseCommitSha) {
        return fail("TARGET_IMAGE_DIGEST_MISMATCH", "Target image digest mismatch");
      }
    }
    const migrationIdentity = await run(config.dockerBinary, [
      "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--entrypoint=node", references.runtime,
      "--experimental-strip-types", "scripts/release/migration-registry-identity.mjs",
    ], { environment, timeoutMs: 60_000 });
    const migration = JSON.parse(migrationIdentity.stdout) as Record<string, unknown>;
    if (Object.keys(migration).sort().join(",") !== "migrationCount,migrationRegistrySha256,migrationVersion"
      || migration.migrationRegistrySha256 !== material.migrationSetSha256
      || migration.migrationVersion !== material.migrationVersion
      || !Number.isSafeInteger(migration.migrationCount) || Number(migration.migrationCount) < 1) {
      return fail("TARGET_MIGRATION_SET_MISMATCH", "Target migration set mismatch");
    }
    return { references, environment };
  }

  async function probePhysicalDesired(
    identity: TargetOperationIdentity,
    materialInput: RestrictedCicdDeploymentMaterial,
  ) {
    const material = validateMaterial(materialInput);
    const environment = commandEnvironment(config, identity, material);
    const references = imageReferences(config, material);
    for (const service of FIXED_SERVICES) {
      const expected = service === "client" || service === "operations" || service === "maintenance"
        ? references[service]
        : references.runtime;
      const inspected = await run(config.dockerBinary, [
        "inspect", "--format={{.Config.Image}} {{.State.Running}}", `${config.composeProject}-${service}-1`,
      ], { environment, timeoutMs: 30_000 });
      if (inspected.stdout.trim() !== `${expected} true`) return { matched: false } as const;
    }
    return { matched: true } as const;
  }

  async function probeDesired(
    identity: TargetOperationIdentity,
    materialInput: RestrictedCicdDeploymentMaterial,
    ownerIdentitySha256: string,
  ) {
    if (!SHA256.test(ownerIdentitySha256)) return fail("TARGET_OWNER_STALE", "Target owner identity stale");
    const material = validateMaterial(materialInput);
    const physical = await probePhysicalDesired(identity, material);
    if (!physical.matched) return physical;
    const marker = await readMarker();
    if (!marker || marker.operationId !== identity.operationId
      || marker.releaseVersionId !== identity.releaseVersionId
      || JSON.stringify(marker.imageDigests) !== JSON.stringify(material.imageDigests)
      || marker.migrationRegistrySha256 !== material.migrationSetSha256
      || marker.environmentGeneration !== identity.environmentGeneration
      || marker.ownerIdentitySha256 !== ownerIdentitySha256) {
      return { matched: false } as const;
    }
    return { matched: true } as const;
  }

  async function commitMarker(
    identity: TargetOperationIdentity,
    materialInput: RestrictedCicdDeploymentMaterial,
    fence: RestrictedCicdTargetFence,
  ) {
    const material = validateMaterial(materialInput);
    if (!Number.isSafeInteger(fence.ownerEpoch) || fence.ownerEpoch < 1
      || !SHA256.test(fence.ownerIdentitySha256)) {
      return fail("TARGET_OWNER_STALE", "Target owner epoch stale");
    }
    await fence.assertOwned();
    const physical = await probePhysicalDesired(identity, material);
    if (!physical.matched) return fail("TARGET_CUTOVER_UNCERTAIN", "Target cutover outcome uncertain");
    await fence.assertOwned();
    await atomicMarker(config.markerFile, {
      schemaVersion: "1", environment: config.environment, operationId: identity.operationId,
      releaseVersionId: identity.releaseVersionId, releaseTag: material.releaseTag,
      releaseCommitSha: material.releaseCommitSha, imageDigests: material.imageDigests,
      migrationRegistrySha256: material.migrationSetSha256,
      environmentGeneration: identity.environmentGeneration, ownerEpoch: fence.ownerEpoch,
      ownerIdentitySha256: fence.ownerIdentitySha256,
    });
    await fence.assertOwned();
  }

  function restorePlan(identity: TargetOperationIdentity, material: RestrictedCicdDeploymentMaterial,
    backupId: string, backupSha256: string, restoreTocSha256: string) {
    return createHash("sha256").update([
      "restricted-cicd-restore-plan-v1",
      identity.operationId,
      identity.releaseVersionId,
      identity.expectedCurrentReleaseVersionId ?? "",
      String(identity.environmentGeneration),
      material.migrationSetSha256,
      material.migrationVersion,
      backupId,
      backupSha256,
      restoreTocSha256,
      "pg_restore-list-v1",
    ].join("\x1f")).digest("hex");
  }

  return {
    assertCustody,
    async prepare(identity: TargetOperationIdentity, materialInput: RestrictedCicdDeploymentMaterial) {
      if (identity.environment !== config.environment) {
        return fail("TARGET_ENVIRONMENT_MISMATCH", "Target environment mismatch");
      }
      await assertCustody();
      return inspectDesiredImages(identity, materialInput);
    },
    async createBackup(identity: TargetOperationIdentity, materialInput: RestrictedCicdDeploymentMaterial) {
      const material = validateMaterial(materialInput);
      if (!IDENTIFIER.test(identity.operationId)) {
        return fail("TARGET_OPERATION_INVALID", "Target operation invalid");
      }
      const backupId = `backup-${identity.operationId}`;
      const backupFile = path.join(config.backupDirectory, `${backupId}.dump`);
      try {
        const existing = await lstat(backupFile);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size < 1 || (existing.mode & 0o077) !== 0) {
          return fail("TARGET_BACKUP_INVALID", "Target backup invalid");
        }
        const listed = await run(config.pgRestoreBinary, ["--list", backupFile], {
          environment: { PATH: "/usr/bin:/bin", NODE_ENV: "production" }, timeoutMs: 60_000,
        });
        const backupMetadata = await stat(backupFile);
        const backupSha256 = await sha256File(backupFile);
        const restoreTocSha256 = createHash("sha256").update(listed.stdout).digest("hex");
        return {
          backupId, replayed: true,
          backupSha256,
          restoreTocSha256,
          restorePlanSha256: restorePlan(identity, material, backupId, backupSha256, restoreTocSha256),
          createdAt: backupMetadata.mtime,
        };
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      const result = await run(config.dockerBinary, [
        ...compose, "exec", "-T", "postgres", "pg_dump", "--username=postgres",
        "--dbname=agentnovas", "--format=custom", "--no-owner", "--no-privileges",
      ], {
        environment: commandEnvironment(config, identity, material),
        timeoutMs: 10 * 60_000,
        stdoutFile: backupFile,
      });
      if (result.stdoutBytes < 1) return fail("TARGET_BACKUP_INVALID", "Target backup invalid");
      const listed = await run(config.pgRestoreBinary, ["--list", backupFile], {
        environment: { PATH: "/usr/bin:/bin", NODE_ENV: "production" }, timeoutMs: 60_000,
      });
      const backupMetadata = await stat(backupFile);
      const backupSha256 = await sha256File(backupFile);
      const restoreTocSha256 = createHash("sha256").update(listed.stdout).digest("hex");
      return {
        backupId, replayed: false,
        backupSha256,
        restoreTocSha256,
        restorePlanSha256: restorePlan(identity, material, backupId, backupSha256, restoreTocSha256),
        createdAt: backupMetadata.mtime,
      };
    },
    async applyMigrations(identity: TargetOperationIdentity, materialInput: RestrictedCicdDeploymentMaterial) {
      const material = validateMaterial(materialInput);
      const environment = commandEnvironment(config, identity, material);
      await run(config.dockerBinary, [
        ...compose, "run", "--rm", "--no-deps", "migrator",
      ], { environment, timeoutMs: 10 * 60_000 });
    },
    probeDesired,
    probePhysicalDesired,
    commitMarker,
    async cutover(identity: TargetOperationIdentity, materialInput: RestrictedCicdDeploymentMaterial,
      fence: RestrictedCicdTargetFence) {
      const material = validateMaterial(materialInput);
      if (!Number.isSafeInteger(fence.ownerEpoch) || fence.ownerEpoch < 1
        || !SHA256.test(fence.ownerIdentitySha256)) {
        return fail("TARGET_OWNER_STALE", "Target owner epoch stale");
      }
      await fence.assertOwned();
      const active = await readMarker();
      if ((active?.releaseVersionId ?? null) !== identity.expectedCurrentReleaseVersionId) {
        return fail("TARGET_CURRENT_CHANGED", "Target active release changed");
      }
      const environment = commandEnvironment(config, identity, material);
      await fence.assertOwned();
      await run(config.dockerBinary, [
        ...compose, "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120",
        ...FIXED_SERVICES,
      ], { environment, timeoutMs: 5 * 60_000 });
      await fence.assertOwned();
      await commitMarker(identity, material, fence);
    },
    async healthCheck() {
      for (const url of Object.values(config.healthUrls)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await (dependencies.fetchImpl ?? fetch)(url, {
            redirect: "error", signal: controller.signal, headers: { accept: "application/json" },
          });
          if (!response.ok || response.url !== url) return false;
          const body = await response.text();
          if (Buffer.byteLength(body) > 64 * 1024) return false;
          const parsed = JSON.parse(body) as { status?: unknown };
          if (parsed.status !== "ready" && parsed.status !== "ok") return false;
        } catch {
          return false;
        } finally {
          clearTimeout(timeout);
        }
      }
      return true;
    },
    readActiveMarker: readMarker,
  };
}
