import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRestrictedCicdTargetAdapter,
  computeRestrictedCicdTargetBindingSha256,
  parseRestrictedCicdTargetAdapterConfig,
} from "../lib/restricted-cicd-target-adapter.ts";

const sha = (letter) => letter.repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "target-adapter-"));
  const files = ["docker", "pg_restore", "compose.yml", "override.yml"];
  const directories = ["docker-config", "secrets", "backups", "state"];
  for (const file of files) await writeFile(join(root, file), "fixture\n", { mode: 0o600 });
  await chmod(join(root, "docker"), 0o700);
  for (const directory of directories) await mkdir(join(root, directory), { mode: 0o700 });
  const calls = [];
  const config = {
    environment: "staging", dockerBinary: join(root, "docker"), pgRestoreBinary: join(root, "pg_restore"),
    dockerConfigDirectory: join(root, "docker-config"), composeFile: join(root, "compose.yml"),
    composeOverrideFile: join(root, "override.yml"), composeProject: "agentnovas-staging",
    imagePrefix: "ghcr.io/agentnovas/riverton", secretDirectory: join(root, "secrets"),
    backupDirectory: join(root, "backups"), markerFile: join(root, "state", "active.json"),
    ports: { client: 3100, operations: 3101, maintenance: 3102 },
    healthUrls: { client: "http://127.0.0.1:3100/api/health/ready",
      operations: "http://127.0.0.1:3101/api/health/ready",
      maintenance: "http://127.0.0.1:3102/api/health/ready" },
  };
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === "image") return { stdout: JSON.stringify({
      RepoDigests: [args.at(-1)],
      Config: { Labels: { "org.opencontainers.image.version": material.releaseTag,
        "org.opencontainers.image.revision": material.releaseCommitSha } },
    }), stdoutBytes: 180 };
    if (args[0] === "run") return { stdout: JSON.stringify({
      migrationRegistrySha256: material.migrationSetSha256,
      migrationVersion: material.migrationVersion,
      migrationCount: 82,
    }), stdoutBytes: 160 };
    if (args[0] === "inspect") {
      const service = args.at(-1).replace("agentnovas-staging-", "").replace("-1", "");
      const image = ["client", "operations", "maintenance"].includes(service) ? service : "runtime";
      return { stdout: `ghcr.io/agentnovas/riverton-${image}@sha256:${material.imageDigests[image]} true\n`, stdoutBytes: 100 };
    }
    if (options.stdoutFile) {
      await writeFile(options.stdoutFile, "backup-fixture", { mode: 0o600 });
      return { stdout: "", stdoutBytes: 14 };
    }
    return { stdout: "", stdoutBytes: 0 };
  };
  return { root, calls, config, adapter: createRestrictedCicdTargetAdapter(config, {
    run,
    fetchImpl: async (url) => ({
      ok: true,
      url,
      text: async () => '{"status":"ready"}',
    }),
  }) };
}

const identity = {
  commandId: "command-target-1", releaseVersionId: "release-target-1", runId: "778899",
  runAttempt: 1, oidcJtiSha256: sha("1"), authorizationNonce: "authorization-target-1",
  operationId: "operation-target-1", environment: "staging", action: "deploy",
  workflowSha256: sha("2"), artifactManifestSha256: sha("3"), snapshotSha256: sha("4"),
  environmentGeneration: 1, expectedCurrentReleaseVersionId: null,
};
const material = {
  releaseTag: "v1.2.3", releaseCommitSha: "a".repeat(40),
  imageDigests: { client: sha("5"), operations: sha("6"), maintenance: sha("7"), runtime: sha("8") },
  migrationSetSha256: sha("9"), migrationVersion: "0081_restricted_cicd_exact_target_request",
  hasIrreversibleMigrations: false,
};

test("adapter uses only fixed digest image and compose commands", async () => {
  const { root, calls, adapter } = await fixture();
  try {
    await adapter.prepare(identity, material);
    const backup = await adapter.createBackup(identity, material);
    await adapter.applyMigrations(identity, material);
    await adapter.cutover(identity, material, {
      ownerEpoch: 1, ownerIdentitySha256: sha("a"), assertOwned: async () => true,
    });
    assert.equal(await adapter.healthCheck(), true);
    assert.equal(backup.backupId, "backup-operation-target-1");
    assert.ok(calls.filter((call) => call.args[0] === "pull").every((call) => call.args[1].includes("@sha256:")));
    const cutover = calls.find((call) => call.args.includes("up"));
    assert.deepEqual(cutover.args.slice(-8), [
      "client", "operations", "maintenance", "notification-worker",
      "configuration-activation-worker", "runtime-worker", "demo-worker", "execution",
    ]);
    assert.ok(Object.keys(cutover.options.environment).every((key) => [
      "PATH", "NODE_ENV", "DOCKER_CONFIG", "RIVERTON_RELEASE_VERSION", "RIVERTON_COMMIT_SHA",
      "RIVERTON_ARTIFACT_SHA256", "RIVERTON_SECRET_DIR", "RIVERTON_CLIENT_PORT",
      "RIVERTON_OPERATIONS_PORT", "RIVERTON_MAINTENANCE_PORT", "RIVERTON_CLIENT_IMAGE",
      "RIVERTON_OPERATIONS_IMAGE", "RIVERTON_MAINTENANCE_IMAGE", "RIVERTON_RUNTIME_IMAGE",
    ].includes(key)));
    const marker = JSON.parse(await readFile(join(root, "state", "active.json"), "utf8"));
    assert.equal(marker.releaseVersionId, "release-target-1");
    assert.equal(marker.ownerEpoch, 1);
    assert.equal(marker.ownerIdentitySha256, sha("a"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter rejects environment drift and non-loopback health probes", async () => {
  const { root, config, adapter } = await fixture();
  try {
    await assert.rejects(adapter.prepare({ ...identity, environment: "production" }, material),
      (error) => error.code === "TARGET_ENVIRONMENT_MISMATCH");
    assert.throws(() => createRestrictedCicdTargetAdapter({
      ...config, healthUrls: { ...config.healthUrls, client: "https://test.agentnovas.com/api/health/ready" },
    }), (error) => error.code === "TARGET_ADAPTER_CONFIG_INVALID");
    assert.throws(() => parseRestrictedCicdTargetAdapterConfig({
      schemaVersion: "1", ...config, unknown: true,
    }), (error) => error.code === "TARGET_ADAPTER_CONFIG_INVALID");
    assert.match(computeRestrictedCicdTargetBindingSha256(config, sha("a")), /^[a-f0-9]{64}$/);
    assert.notEqual(
      computeRestrictedCicdTargetBindingSha256(config, sha("a"), sha("c")),
      computeRestrictedCicdTargetBindingSha256(config, sha("b"), sha("c")),
    );
    assert.notEqual(
      computeRestrictedCicdTargetBindingSha256(config, sha("a"), sha("c")),
      computeRestrictedCicdTargetBindingSha256(config, sha("a"), sha("d")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
