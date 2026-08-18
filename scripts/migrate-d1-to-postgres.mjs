import { access } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import { migrateD1Database } from "../lib/d1-postgres-migration.ts";

const connectionString = process.env.DATABASE_URL?.trim();
const sqliteInput = process.env.D1_SQLITE_PATH?.trim();
const batchId = process.env.D1_MIGRATION_BATCH_ID?.trim();
const sourceRef = process.env.D1_SOURCE_REF?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!sqliteInput) throw new Error("D1_SQLITE_PATH is required");
if (!batchId || !/^[a-zA-Z0-9._:-]{8,160}$/.test(batchId)) throw new Error("D1_MIGRATION_BATCH_ID is invalid");
if (!sourceRef || sourceRef.length > 500) throw new Error("D1_SOURCE_REF is required");

const sqlitePath = resolve(sqliteInput);
await access(sqlitePath);
const pool = new pg.Pool({ connectionString, max: 2, application_name: "agentnovas-d1-migration" });
try {
  const result = await migrateD1Database({ sqlitePath, database: pool, batchId, sourceRef });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
