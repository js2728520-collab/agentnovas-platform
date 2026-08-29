import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validatedAbsoluteMountSource,
  validatedContainerName,
  validatedReleaseImage,
} from "./container-release-gate-input.mjs";

const MIGRATOR_ENV_PATH = "/run/secrets/agentnovas-migrator.env";
const DUMP_ENTRYPOINT = String.raw`
use strict;
use warnings;

sub decode_url_component {
  my ($value) = @_;
  die "DATABASE_URL invalid\n" if $value =~ /%(?![0-9A-Fa-f]{2})/;
  $value =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/eg;
  die "DATABASE_URL invalid\n" if $value =~ /[\x00-\x1f\x7f]/;
  return $value;
}

my ($env_file, @command) = @ARGV;
die "DATABASE_URL invalid\n" unless defined($env_file) && @command && $command[0] eq "pg_dump";
open my $handle, "<", $env_file or die "DATABASE_URL invalid\n";
my @urls;
while (my $line = <$handle>) {
  $line =~ s/\r?\n\z//;
  push @urls, $1 if $line =~ /\ADATABASE_URL=(.*)\z/;
}
close $handle;
die "DATABASE_URL must appear exactly once\n" unless @urls == 1;
my ($username, $secret, $database) = $urls[0] =~ m{\Apostgres(?:ql)?://([^:/@]+):([^/@]*)@[^/?#]+/([^/?#]+)\z};
die "DATABASE_URL invalid\n" unless defined($database);
$ENV{PGHOST} = "127.0.0.1";
$ENV{PGPORT} = "5432";
$ENV{PGUSER} = decode_url_component($username);
$ENV{PGPASSWORD} = decode_url_component($secret);
$ENV{PGDATABASE} = decode_url_component($database);
delete $ENV{DATABASE_URL};
exec { $command[0] } @command;
die "pg_dump start failed\n";
`.trim();

function validatedOutputPath(value) {
  const normalized = validatedAbsoluteMountSource(value, "output path");
  const parent = path.dirname(normalized);
  const name = path.basename(normalized);
  if (parent === "/" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.dump$/.test(name)) {
    throw new Error("output path must use a controlled .dump filename below an explicit directory");
  }
  return normalized;
}

export function planContainerPostgresBackupGate(input) {
  const targetContainer = validatedContainerName(input?.containerName);
  const targetEnvFile = validatedAbsoluteMountSource(input?.envFile, "env file");
  const targetOutput = validatedOutputPath(input?.outputPath);
  const toolsImage = validatedReleaseImage(input?.postgresToolsImage, "PostgreSQL tools image");
  const outputDirectory = path.dirname(targetOutput);
  const outputName = path.basename(targetOutput);
  return Object.freeze({
    outputPath: targetOutput,
    dump: Object.freeze({
      executable: "docker",
      args: Object.freeze([
        "run",
        "--rm",
        "--network",
        `container:${targetContainer}`,
        "--mount",
        `type=bind,src=${targetEnvFile},dst=${MIGRATOR_ENV_PATH},readonly`,
        toolsImage,
        "perl",
        "-e",
        DUMP_ENTRYPOINT,
        MIGRATOR_ENV_PATH,
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--enable-row-security",
      ]),
    }),
    verify: Object.freeze({
      executable: "docker",
      args: Object.freeze([
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${outputDirectory},dst=/backup,readonly`,
        toolsImage,
        "pg_restore",
        "--list",
        `/backup/${outputName}`,
      ]),
    }),
  });
}

function runDumpToFile(command, fileDescriptor) {
  return new Promise((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      stdio: ["ignore", fileDescriptor, "pipe"],
    });
    let settled = false;
    let stderrBytes = 0;
    const stderrChunks = [];
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderrChunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ status: null, startError: true });
      }
    });
    child.on("close", (status) => {
      if (!settled) {
        settled = true;
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        let failureCode;
        if (status !== 0) {
          if (/DATABASE_URL (?:must appear|invalid)|DATABASE_URL is required/i.test(stderr)) {
            failureCode = "configuration_invalid";
          } else if (/authentication failed|no password supplied/i.test(stderr)) {
            failureCode = "authentication_failed";
          } else if (/no pg_hba\.conf entry/i.test(stderr)) {
            failureCode = "hba_rejected";
          } else if (/database .* does not exist/i.test(stderr)) {
            failureCode = "database_missing";
          } else if (/role .* does not exist/i.test(stderr)) {
            failureCode = "identity_missing";
          } else if (/permission denied|row security|must be (?:owner|superuser)/i.test(stderr)) {
            failureCode = "authorization_failed";
          } else if (/connection refused/i.test(stderr)) {
            failureCode = "connection_refused";
          } else if (/could not translate host name/i.test(stderr)) {
            failureCode = "name_resolution_failed";
          } else if (/SSL (?:error|is not enabled)|certificate verify failed/i.test(stderr)) {
            failureCode = "tls_failed";
          } else if (/connection .*failed|could not translate host name|server closed the connection|network is unreachable|connection refused|timeout expired/i.test(stderr)) {
            failureCode = "connection_failed";
          } else {
            failureCode = "command_failed";
          }
        }
        resolve({ status, failureCode });
      }
    });
  });
}

function verifyDumpToc(command) {
  return spawnSync(command.executable, [...command.args], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 1024 * 1024,
  });
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function removeIncompleteOutput(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runContainerPostgresBackupGate(input, dependencies = {}) {
  const plan = planContainerPostgresBackupGate(input);
  const openOutput = dependencies.openOutput ?? open;
  const runDump = dependencies.runDump ?? runDumpToFile;
  const statOutput = dependencies.statOutput ?? stat;
  const runVerify = dependencies.runVerify ?? verifyDumpToc;
  const hashOutput = dependencies.hashOutput ?? sha256File;
  const removeOutput = dependencies.removeOutput ?? removeIncompleteOutput;
  let output;
  let created = false;
  try {
    output = await openOutput(plan.outputPath, "wx", 0o600);
    created = true;
    const dumped = await runDump(plan.dump, output.fd);
    await output.close();
    output = undefined;
    if (dumped?.startError) throw new Error("container PostgreSQL dump command could not start");
    if (dumped?.status !== 0) {
      const allowedFailureCodes = new Set([
        "configuration_invalid",
        "authentication_failed",
        "hba_rejected",
        "database_missing",
        "identity_missing",
        "authorization_failed",
        "connection_refused",
        "name_resolution_failed",
        "tls_failed",
        "connection_failed",
        "command_failed",
      ]);
      const failureCode = allowedFailureCodes.has(dumped?.failureCode) ? ` (${dumped.failureCode})` : "";
      throw new Error(`container PostgreSQL dump exited with status ${dumped?.status ?? "unknown"}${failureCode}`);
    }
    const metadata = await statOutput(plan.outputPath);
    if (!Number.isSafeInteger(metadata?.size) || metadata.size <= 0) {
      throw new Error("container PostgreSQL dump output is empty or invalid");
    }
    const verified = runVerify(plan.verify);
    if (verified?.error) throw new Error("PostgreSQL backup TOC verification could not start");
    if (verified?.status !== 0) {
      throw new Error(`PostgreSQL backup TOC verification exited with status ${verified?.status ?? "unknown"}`);
    }
    const sha256 = await hashOutput(plan.outputPath);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("PostgreSQL backup SHA-256 invalid");
    return Object.freeze({
      outputPath: plan.outputPath,
      bytes: metadata.size,
      sha256,
      tocVerified: true,
    });
  } catch (error) {
    if (output) {
      try {
        await output.close();
      } catch {
        // The exact newly created output is still removed below.
      }
    }
    if (created) {
      try {
        await removeOutput(plan.outputPath);
      } catch {
        throw new Error("PostgreSQL backup failed and incomplete output cleanup failed");
      }
    }
    throw error;
  }
}

function cliInput(argv) {
  const execute = argv.includes("--execute");
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--execute") continue;
    const match = /^--(container|postgres-tools-image|migrator-env-file|output)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new Error("arguments invalid");
    values.set(match[1], match[2]);
  }
  if (values.size !== 4) throw new Error("arguments invalid");
  return {
    execute,
    input: {
      containerName: values.get("container"),
      envFile: values.get("migrator-env-file"),
      postgresToolsImage: values.get("postgres-tools-image"),
      outputPath: values.get("output"),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { execute, input } = cliInput(process.argv.slice(2));
    const result = execute
      ? await runContainerPostgresBackupGate(input)
      : { event: "container_postgres_backup_plan", ...planContainerPostgresBackupGate(input) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "container PostgreSQL backup failed"}\n`);
    process.exitCode = 1;
  }
}
