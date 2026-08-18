import { drizzle } from "drizzle-orm/d1";
import { getPostgresPool } from "@/lib/postgres";
import * as schema from "./schema";

type BusinessDatabase = ReturnType<typeof drizzle<typeof schema>>;

const databaseUrl = process.env.DATABASE_URL?.trim();
const postgresDatabase = databaseUrl
  ? await import("./postgres").then(async ({ createPostgresBusinessDb }) => (
      createPostgresBusinessDb(await getPostgresPool()) as unknown as BusinessDatabase
    ))
  : null;
const workerEnvironment = databaseUrl
  ? null
  : await import("cloudflare:workers").then(module => module.env);

export function getDb(): BusinessDatabase {
  if (postgresDatabase) return postgresDatabase;
  if (!workerEnvironment?.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(workerEnvironment.DB, { schema });
}
