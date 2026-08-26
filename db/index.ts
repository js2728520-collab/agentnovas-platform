import type { drizzle as createTypedBusinessDb } from "drizzle-orm/d1";
import { getDeferredPostgresPool } from "../lib/postgres.ts";
import { createPostgresBusinessDb } from "./postgres.ts";
import * as schema from "./schema.ts";

type BusinessDatabase = Omit<ReturnType<typeof createTypedBusinessDb<typeof schema>>, "batch"> & {
  batch: (queries: readonly unknown[]) => Promise<unknown[]>;
};

const postgresDatabase = createPostgresBusinessDb(getDeferredPostgresPool()) as unknown as BusinessDatabase;

export function getDb() {
  return postgresDatabase;
}
