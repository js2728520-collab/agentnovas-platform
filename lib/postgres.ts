import type { Pool } from "pg";

let poolPromise: Promise<Pool> | undefined;

export async function getPostgresPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const connectionString = process.env.DATABASE_URL?.trim();
      if (!connectionString) throw new Error("PostgreSQL DATABASE_URL 尚未配置");
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,
        max: 12,
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
