import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const MIGRATION_FILE = /^\d+_[a-z0-9_]+\.sql$/;
// Cluster-global DDL mutex. Migrations converge ACLs by enumerating pg_roles, so
// anything that creates or drops a cluster-global role has to take this same lock
// or the enumeration can outlive the role it snapshotted.
export const POSTGRES_MIGRATION_LOCK_KEY = "agentnovas:postgres-migrations:v1";
const MIGRATION_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

function validatedMigrationSchema(value) {
  const schema = typeof value === "string" ? value.trim() : "";
  if (!MIGRATION_SCHEMA.test(schema) || SYSTEM_SCHEMAS.has(schema) || schema.startsWith("pg_")) {
    throw new Error(`Unsafe PostgreSQL migration schema: ${schema || "<empty>"}`);
  }
  return schema;
}

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function migrationSchemaSearchPath(value) {
  return `${quotedIdentifier(validatedMigrationSchema(value))},pg_catalog`;
}

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function planPostgresMigrations(migrations, appliedRows) {
  const pending = [];
  const skipped = [];

  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!MIGRATION_FILE.test(migration.name)) throw new Error(`Invalid PostgreSQL migration filename: ${migration.name}`);
    const checksum = migrationChecksum(migration.sql);
    const applied = appliedRows.get(migration.name);
    if (!applied) {
      pending.push({ ...migration, checksum });
      continue;
    }
    if (!applied.checksum) {
      throw new Error(`Legacy migration checksum missing for ${migration.name}; controlled reconciliation is required`);
    }
    if (applied.checksum !== checksum) throw new Error(`Checksum mismatch for ${migration.name}`);
    skipped.push(migration.name);
  }

  return { pending, skipped };
}

export async function loadPostgresMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
  if (!names.length) throw new Error("No PostgreSQL migrations found");
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, directory), "utf8"),
  })));
}

async function resolveMigrationSchema(client, configuredSchema) {
  if (configuredSchema?.trim()) {
    const schema = validatedMigrationSchema(configuredSchema);
    const result = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema]);
    if (!result.rows[0]) throw new Error(`PostgreSQL migration schema does not exist: ${schema}`);
    return schema;
  }
  const result = await client.query(`
    SELECT schema_name
      FROM unnest(current_schemas(false)) WITH ORDINALITY AS candidate(schema_name, ordinal)
     WHERE schema_name NOT IN ('pg_catalog','information_schema')
       AND schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
     ORDER BY ordinal
     LIMIT 1
  `);
  if (!result.rows[0]?.schema_name) throw new Error("No controlled PostgreSQL migration schema is configured");
  return validatedMigrationSchema(result.rows[0].schema_name);
}

async function ensureMigrationRegistry(client, schema) {
  const registry = `${quotedIdentifier(schema)}."_agentnovas_migrations"`;
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${registry} (
      "name" text PRIMARY KEY,
      "applied_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  `);
  await client.query(`ALTER TABLE ${registry} ADD COLUMN IF NOT EXISTS "checksum" text`);
  await client.query(`ALTER TABLE ${registry} ADD COLUMN IF NOT EXISTS "commit_sha" text`);
}

export async function runPostgresMigrations(pool, {
  directory = new URL("../postgres/migrations/", import.meta.url),
  commitSha = process.env.GIT_COMMIT_SHA?.trim() || null,
  migrationSchema = process.env.POSTGRES_MIGRATION_SCHEMA?.trim() || null,
} = {}) {
  const migrations = await loadPostgresMigrations(directory);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [POSTGRES_MIGRATION_LOCK_KEY]);
    locked = true;
    const schema = await resolveMigrationSchema(client, migrationSchema);
    const registry = `${quotedIdentifier(schema)}."_agentnovas_migrations"`;
    const searchPath = migrationSchemaSearchPath(schema);
    await ensureMigrationRegistry(client, schema);
    const result = await client.query(`SELECT "name", "checksum" FROM ${registry} ORDER BY "name"`);
    const appliedRows = new Map(result.rows.map((row) => [row.name, { checksum: row.checksum ?? null }]));
    const plan = planPostgresMigrations(migrations, appliedRows);

    for (const migration of plan.pending) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('search_path',$1,true)", [searchPath]);
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${registry} ("name", "checksum", "commit_sha") VALUES ($1, $2, $3)`,
          [migration.name, migration.checksum, commitSha],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return {
      applied: plan.pending.map((migration) => migration.name),
      skipped: plan.skipped,
      total: migrations.length,
    };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [POSTGRES_MIGRATION_LOCK_KEY]);
    client.release();
  }
}
