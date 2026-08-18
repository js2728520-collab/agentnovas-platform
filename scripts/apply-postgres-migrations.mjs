import { readdir, readFile } from "node:fs/promises";

import pg from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 1, application_name: "agentnovas-migrations" });

try {
  const directory = new URL("../postgres/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error("No PostgreSQL migrations found");
  for (const file of files) {
    const migration = await readFile(new URL(file, directory), "utf8");
    await pool.query(migration);
  }
  process.stdout.write(`PostgreSQL migrations applied (${files.length}).\n`);
} finally {
  await pool.end();
}
