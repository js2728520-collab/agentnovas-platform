import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const MIGRATION_FILE = /^\d+_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "agentnovas:postgres-migrations:v1";

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function planPostgresMigrations(migrations, appliedRows) {
  const pending = [];
  const legacyBackfills = [];
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
      legacyBackfills.push({ name: migration.name, checksum });
      continue;
    }
    if (applied.checksum !== checksum) throw new Error(`Checksum mismatch for ${migration.name}`);
    skipped.push(migration.name);
  }

  return { pending, legacyBackfills, skipped };
}

export async function loadPostgresMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort();
  if (!names.length) throw new Error("No PostgreSQL migrations found");
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, directory), "utf8"),
  })));
}

async function ensureMigrationRegistry(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_agentnovas_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  `);
  await client.query(`ALTER TABLE "_agentnovas_migrations" ADD COLUMN IF NOT EXISTS "checksum" text`);
  await client.query(`ALTER TABLE "_agentnovas_migrations" ADD COLUMN IF NOT EXISTS "commit_sha" text`);
}

export async function runPostgresMigrations(pool, {
  directory = new URL("../postgres/migrations/", import.meta.url),
  commitSha = process.env.GIT_COMMIT_SHA?.trim() || null,
} = {}) {
  const migrations = await loadPostgresMigrations(directory);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    locked = true;
    await ensureMigrationRegistry(client);
    const result = await client.query(`SELECT "name", "checksum" FROM "_agentnovas_migrations" ORDER BY "name"`);
    const appliedRows = new Map(result.rows.map((row) => [row.name, { checksum: row.checksum ?? null }]));
    const plan = planPostgresMigrations(migrations, appliedRows);

    for (const migration of plan.legacyBackfills) {
      await client.query(
        `UPDATE "_agentnovas_migrations" SET "checksum" = $2, "commit_sha" = COALESCE("commit_sha", $3) WHERE "name" = $1 AND "checksum" IS NULL`,
        [migration.name, migration.checksum, commitSha],
      );
    }

    for (const migration of plan.pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO "_agentnovas_migrations" ("name", "checksum", "commit_sha") VALUES ($1, $2, $3)`,
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
      backfilled: plan.legacyBackfills.map((migration) => migration.name),
      skipped: plan.skipped,
      total: migrations.length,
    };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
