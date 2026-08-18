import { readFile } from "node:fs/promises";

import pg from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 1, application_name: "agentnovas-migrations" });

try {
  const migration = await readFile(new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url), "utf8");
  await pool.query(migration);
  process.stdout.write("PostgreSQL strategy research migration applied.\n");
} finally {
  await pool.end();
}
