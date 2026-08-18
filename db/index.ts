import type { drizzle as createTypedBusinessDb } from "drizzle-orm/d1";
import { getPostgresPool } from "@/lib/postgres";
import { createPostgresBusinessDb } from "./postgres";
import * as schema from "./schema";

type BusinessDatabase = Omit<ReturnType<typeof createTypedBusinessDb<typeof schema>>, "batch"> & {
  batch: (queries: readonly unknown[]) => Promise<unknown[]>;
};

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL 尚未配置；AgentNovas 仅支持 Node.js + PostgreSQL 运行时");
const postgresDatabase = createPostgresBusinessDb(await getPostgresPool()) as unknown as BusinessDatabase;

export function getDb() {
  return postgresDatabase;
}
