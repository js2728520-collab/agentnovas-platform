import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import pg from "pg";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const REHEARSAL_SOURCE_DATABASE_NAME = /^agentnovas_recovery_source_[a-z0-9_]+$/;
const REHEARSAL_DATABASE_NAME = /^agentnovas_restore_rehearsal_[0-9]+_[0-9]{13}_[a-f0-9]{6}$/;
const TEMP_DIRECTORY_NAME = /^agentnovas-release-recovery-[A-Za-z0-9_-]{6,}$/;

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Unsafe percent-encoding in PostgreSQL URL");
  }
}

export function assertLoopbackPostgresUrl(rawUrl, {
  allowAdminDatabase = false,
  requireRehearsalSource = true,
} = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error("Unsafe PostgreSQL URL");
  }
  const databaseName = decoded(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || !url.username
    || url.hash
    || url.search
    || !DATABASE_NAME.test(databaseName)) {
    throw new Error("Unsafe PostgreSQL URL; use an explicit loopback host, login role, and database");
  }
  if (allowAdminDatabase) {
    if (databaseName !== "postgres") throw new Error("Recovery rehearsal admin database must be postgres");
  } else if (["postgres", "template0", "template1"].includes(databaseName)
    || (requireRehearsalSource && !REHEARSAL_SOURCE_DATABASE_NAME.test(databaseName))) {
    throw new Error("Unsafe recovery rehearsal source database");
  }
  return url;
}

export function assertRestorableMigrationEvidence(evidence) {
  if (!evidence.tables.includes("_agentnovas_migrations") || evidence.migrations.length === 0) {
    throw new Error("Recovery source is missing a populated migration registry");
  }
  for (const migration of evidence.migrations) {
    if (!/^[a-f0-9]{64}$/.test(String(migration.checksum ?? ""))) {
      throw new Error(`Recovery source has an invalid migration checksum: ${migration.name}`);
    }
  }
  return evidence;
}

export function assertRecoveryRehearsalAuthorized({ execute, environment }) {
  if (!execute) throw new Error("Recovery rehearsal is disabled; pass --execute explicitly");
  if (environment.RELEASE_REHEARSAL_ALLOW_LOCAL !== "1") {
    throw new Error("Recovery rehearsal requires RELEASE_REHEARSAL_ALLOW_LOCAL=1");
  }
}

export function assertControlledRehearsalDatabaseName(name) {
  if (!REHEARSAL_DATABASE_NAME.test(String(name))) {
    throw new Error("Refusing operation outside a controlled rehearsal database");
  }
  return String(name);
}

export function databaseConnectionOptions(url) {
  const username = decoded(url.username);
  const password = decoded(url.password);
  const args = ["--host", url.hostname, "--port", url.port || "5432", "--username", username];
  return {
    args,
    environment: {
      ...process.env,
      ...(password ? { PGPASSWORD: password } : {}),
    },
  };
}

function controlledTemporaryDirectory(path) {
  const normalized = resolve(path);
  if (dirname(normalized) !== resolve(tmpdir()) || !TEMP_DIRECTORY_NAME.test(basename(normalized))) {
    throw new Error("Refusing cleanup outside the owned recovery rehearsal directory");
  }
  return normalized;
}

function rehearsalDatabaseName() {
  return assertControlledRehearsalDatabaseName(
    `agentnovas_restore_rehearsal_${process.pid}_${Date.now()}_${randomBytes(3).toString("hex")}`,
  );
}

async function runPostgresTool(command, args, url) {
  const connection = databaseConnectionOptions(url);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...connection.args, ...args], {
      env: connection.environment,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim().slice(0, 1_000)}`));
    });
  });
}

function urlForDatabase(url, databaseName) {
  const next = new URL(url);
  next.pathname = `/${databaseName}`;
  return next;
}

async function databaseEvidence(url) {
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    application_name: "agentnovas-release-recovery-evidence",
  });
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name
    `);
    const registryExists = tables.rows.some((row) => row.table_name === "_agentnovas_migrations");
    const migrations = registryExists
      ? await pool.query(`SELECT name, checksum, commit_sha FROM "_agentnovas_migrations" ORDER BY name`)
      : { rows: [] };
    const rowCounts = {};
    for (const row of tables.rows) {
      const identifier = `"${String(row.table_name).replaceAll('"', '""')}"`;
      const count = await pool.query(`SELECT count(*)::text AS count FROM public.${identifier}`);
      rowCounts[row.table_name] = count.rows[0].count;
    }
    return {
      tables: tables.rows.map((row) => row.table_name),
      rowCounts,
      migrations: migrations.rows.map((row) => ({
        name: row.name,
        checksum: row.checksum,
        commitSha: row.commit_sha,
      })),
    };
  } finally {
    await pool.end();
  }
}

function parseArguments(argumentsList) {
  const allowed = new Set(["--execute"]);
  for (const argument of argumentsList) {
    if (!allowed.has(argument)) throw new Error(`Unknown recovery rehearsal argument: ${argument}`);
  }
  return {
    execute: argumentsList.includes("--execute"),
  };
}

async function runRecoveryRehearsal() {
  const input = parseArguments(process.argv.slice(2));
  assertRecoveryRehearsalAuthorized({ execute: input.execute, environment: process.env });
  const source = assertLoopbackPostgresUrl(process.env.RELEASE_REHEARSAL_SOURCE_DATABASE_URL?.trim());
  const admin = assertLoopbackPostgresUrl(
    process.env.RELEASE_REHEARSAL_ADMIN_DATABASE_URL?.trim(),
    { allowAdminDatabase: true },
  );
  const targetDatabase = rehearsalDatabaseName();
  const target = urlForDatabase(admin, targetDatabase);
  const temporaryDirectory = controlledTemporaryDirectory(await mkdtemp(join(tmpdir(), "agentnovas-release-recovery-")));
  const dumpPath = join(temporaryDirectory, "database.dump");
  let databaseCreated = false;
  try {
    const before = assertRestorableMigrationEvidence(await databaseEvidence(source));
    await runPostgresTool("pg_dump", [
      "--dbname", decoded(source.pathname.slice(1)),
      "--format", "custom",
      "--no-owner",
      "--no-privileges",
      "--file", dumpPath,
    ], source);
    await runPostgresTool("createdb", [
      "--maintenance-db", "postgres",
      "--template", "template0",
      targetDatabase,
    ], admin);
    databaseCreated = true;
    await runPostgresTool("pg_restore", [
      "--dbname", targetDatabase,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      dumpPath,
    ], admin);
    const after = assertRestorableMigrationEvidence(await databaseEvidence(target));
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error("Restored schema or migration registry does not match the source backup");
    }
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      sourceDatabase: decoded(source.pathname.slice(1)),
      targetDatabase,
      tableCount: after.tables.length,
      migrationCount: after.migrations.length,
      retained: false,
    })}\n`);
  } finally {
    try {
      if (databaseCreated) {
        await runPostgresTool("dropdb", [
          "--maintenance-db", "postgres",
          "--if-exists",
          "--force",
          assertControlledRehearsalDatabaseName(targetDatabase),
        ], admin);
      }
    } finally {
      await rm(controlledTemporaryDirectory(temporaryDirectory), { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecoveryRehearsal().catch((error) => {
    process.stderr.write(`PostgreSQL recovery rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
