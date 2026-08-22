import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import * as schema from "./schema.ts";

type PreparedQuery = {
  client: Pool | PoolClient;
  execute: () => Promise<unknown>;
};

type BatchQuery = {
  _prepare: () => PreparedQuery;
};

/**
 * The business schema intentionally keeps SQLite-compatible integer booleans
 * and ISO timestamp text. This lets the existing strictly typed Drizzle table
 * objects use PostgreSQL's dialect while the D1 cutover remains a one-time data
 * move instead of a simultaneous application rewrite.
 */
export function createPostgresBusinessDb(pool: Pool) {
  const database = drizzle(pool, { schema });

  Object.defineProperty(database, "batch", {
    configurable: false,
    enumerable: false,
    value: async (queries: BatchQuery[]) => {
      if (!Array.isArray(queries) || queries.length === 0) throw new Error("PostgreSQL batch 至少需要一条语句");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results: unknown[] = [];
        for (const query of queries) {
          if (!query || typeof query._prepare !== "function") throw new Error("PostgreSQL batch 包含无效语句");
          const prepared = query._prepare();
          prepared.client = client;
          results.push(await prepared.execute());
        }
        await client.query("COMMIT");
        return results;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });

  return database;
}
