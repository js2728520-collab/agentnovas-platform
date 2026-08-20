import type { Pool } from "pg";

let poolPromise: Promise<Pool> | undefined;

export function businessDatabaseUrl(environment: Record<string, string | undefined> = process.env) {
  return environment.DATABASE_URL?.trim() || "";
}

export function researchDatabaseUrl(environment: Record<string, string | undefined> = process.env) {
  return environment.RESEARCH_DATABASE_URL?.trim() || environment.DATABASE_URL?.trim() || "";
}

export function researchDatabaseMaxUses(environment: Record<string, string | undefined> = process.env) {
  const value = Number(environment.RESEARCH_DATABASE_MAX_USES);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function getPostgresPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const connectionString = researchDatabaseUrl();
      if (!connectionString) throw new Error("PostgreSQL RESEARCH_DATABASE_URL 或 DATABASE_URL 尚未配置");
      const maxUses = researchDatabaseMaxUses();
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,
        max: 12,
        ...(maxUses ? { maxUses } : {}),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: "agentnovas-web",
      });
      pool.on("error", error => {
        console.error("PostgreSQL idle client error", { code: "code" in error ? error.code : "UNKNOWN" });
      });
      return pool;
    })();
  }
  return poolPromise;
}

export async function checkPostgresConnection() {
  const pool = await getPostgresPool();
  await pool.query("SELECT 1");
  return true;
}
