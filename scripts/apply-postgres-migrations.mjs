import pg from "pg";

import { runPostgresMigrations } from "./postgres-migration-runner.mjs";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 1, application_name: "agentnovas-migrations" });

try {
  const result = await runPostgresMigrations(pool);
  process.stdout.write(`PostgreSQL migrations complete (${result.applied.length} applied, ${result.skipped.length} skipped, ${result.total} total).\n`);
} finally {
  await pool.end();
}
