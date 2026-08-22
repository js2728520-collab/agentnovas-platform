import type { drizzle as createTypedBusinessDb } from "drizzle-orm/d1";
import { getDeferredPostgresPool } from "@/lib/postgres";
import { createPostgresBusinessDb } from "./postgres";
import * as schema from "./schema";

type BusinessDatabase = Omit<ReturnType<typeof createTypedBusinessDb<typeof schema>>, "batch"> & {
  batch: (queries: readonly unknown[]) => Promise<unknown[]>;
};

const postgresDatabase = createPostgresBusinessDb(getDeferredPostgresPool()) as unknown as BusinessDatabase;

export function getDb() {
  return postgresDatabase;
}
