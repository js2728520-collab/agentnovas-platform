import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  planContainerPostgresBackupGate,
  runContainerPostgresBackupGate,
} from "../scripts/release/container-postgres-backup-gate.mjs";

const validInput = Object.freeze({
  containerName: "agentnovas-riverton-preview-postgres-1",
  envFile: "/etc/agentnovas-riverton-preview/migrator.env",
  outputPath: "/opt/agentnovas-riverton-preview/releases/release-1/preview-before-migrations.dump",
  postgresToolsImage: "postgres:16.14-bookworm",
});

test("plans a credential-free custom dump and read-only TOC verification", () => {
  const plan = planContainerPostgresBackupGate(validInput);

  assert.equal(plan.outputPath, validInput.outputPath);
  assert.equal(plan.dump.executable, "docker");
  assert.deepEqual(plan.dump.args.slice(0, 4), ["run", "--rm", "--network", `container:${validInput.containerName}`]);
  assert.ok(plan.dump.args.includes("--mount"));
  assert.ok(plan.dump.args.some((argument) => argument.includes(`src=${validInput.envFile}`)));
  assert.ok(!plan.dump.args.some((argument) => argument.startsWith("--env-file")));
  assert.ok(plan.dump.args.includes("perl"));
  assert.ok(plan.dump.args.includes("-e"));
  assert.match(plan.dump.args.join("\n"), /PGDATABASE/);
  assert.match(plan.dump.args.join("\n"), /PGPASSWORD/);
  assert.match(plan.dump.args.join("\n"), /PGHOST/);
  assert.doesNotMatch(plan.dump.args.join("\n"), /\bsource\b/);
  assert.ok(plan.dump.args.includes("--format=custom"));
  assert.ok(plan.dump.args.includes("--no-owner"));
  assert.ok(plan.dump.args.includes("--no-acl"));
  assert.ok(plan.dump.args.includes("--enable-row-security"));
  assert.match(plan.dump.args.join("\n"), /127\.0\.0\.1/);
  assert.ok(!plan.dump.args.some((argument) => argument.startsWith("--host=")));
  assert.ok(!plan.dump.args.includes("sh"));
  assert.ok(!plan.dump.args.includes("-v"));

  assert.equal(plan.verify.executable, "docker");
  assert.deepEqual(plan.verify.args.slice(0, 3), ["run", "--rm", "--mount"]);
  assert.match(plan.verify.args[3], /dst=\/backup,readonly$/);
  assert.ok(plan.verify.args.includes(validInput.postgresToolsImage));
  assert.deepEqual(plan.verify.args.slice(-2), [
    "--list",
    "/backup/preview-before-migrations.dump",
  ]);

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\/[^*"' ]+@/i);
  assert.doesNotMatch(serialized, /replace-me|very-secret|secret@/i);
});

test("rejects unsafe or ambiguous backup targets", () => {
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, containerName: "../postgres" }),
    /container name/i,
  );
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, outputPath: "preview.dump" }),
    /absolute/i,
  );
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, envFile: "./migrator.env" }),
    /absolute/i,
  );
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, outputPath: "/tmp/not-a-dump.sql" }),
    /output path/i,
  );
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, outputPath: "/tmp/bad,name.dump" }),
    /output path/i,
  );
  assert.throws(
    () => planContainerPostgresBackupGate({ ...validInput, postgresToolsImage: "postgres:latest" }),
    /tools image/i,
  );
});

test("returns verified size and digest only after dump and TOC success", async () => {
  const calls = [];
  const report = await runContainerPostgresBackupGate(validInput, {
    async openOutput() {
      calls.push("open");
      return { fd: 7, close: async () => calls.push("close") };
    },
    async runDump(command, fileDescriptor) {
      calls.push(["dump", command, fileDescriptor]);
      return { status: 0 };
    },
    async statOutput() {
      calls.push("stat");
      return { size: 754152 };
    },
    runVerify(command) {
      calls.push(["verify", command]);
      return { status: 0 };
    },
    async hashOutput() {
      calls.push("hash");
      return "a".repeat(64);
    },
    async removeOutput() {
      calls.push("remove");
    },
  });

  assert.deepEqual(report, {
    outputPath: validInput.outputPath,
    bytes: 754152,
    sha256: "a".repeat(64),
    tocVerified: true,
  });
  assert.equal(calls.includes("remove"), false);
  assert.deepEqual(calls.filter((entry) => typeof entry === "string"), ["open", "close", "stat", "hash"]);
});

test("removes only the newly created output when dump or TOC verification fails", async () => {
  for (const failure of ["dump", "verify"]) {
    const calls = [];
    await assert.rejects(
      runContainerPostgresBackupGate(validInput, {
        async openOutput() {
          return { fd: 8, close: async () => calls.push("close") };
        },
        async runDump() {
          return {
            status: failure === "dump" ? 9 : 0,
            failureCode: failure === "dump" ? "connection_failed" : undefined,
          };
        },
        async statOutput() {
          return { size: 42 };
        },
        runVerify() {
          return { status: failure === "verify" ? 11 : 0 };
        },
        async hashOutput() {
          return "b".repeat(64);
        },
        async removeOutput(path) {
          calls.push(["remove", path]);
        },
      }),
      failure === "dump" ? /dump exited with status 9 \(connection_failed\)/i : /TOC verification exited with status 11/i,
    );
    assert.deepEqual(calls.at(-1), ["remove", validInput.outputPath]);
  }
});

test("CLI dry-run uses Node-safe options and does not create the output", () => {
  const result = spawnSync(process.execPath, [
    "scripts/release/container-postgres-backup-gate.mjs",
    `--container=${validInput.containerName}`,
    `--postgres-tools-image=${validInput.postgresToolsImage}`,
    `--migrator-env-file=${validInput.envFile}`,
    `--output=${validInput.outputPath}`,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.event, "container_postgres_backup_plan");
  assert.equal(report.outputPath, validInput.outputPath);
});
