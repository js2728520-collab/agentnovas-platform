import pg from "pg";
import type { Pool } from "pg";

let poolPromise: Promise<Pool> | undefined;
let clientAuthPoolPromise: Promise<Pool> | undefined;

/**
 * Drizzle is constructed while Next.js discovers Route Handlers during a
 * production build. Opening or validating a database connection at module
 * evaluation time makes a build depend on production credentials. This is a
 * real pg.Pool instance so Drizzle's transaction detector remains correct after
 * production minification, but its query/connect methods delegate only after
 * getPostgresPool has verified the audience-bound role.
 */
const deferredPostgresPool = new pg.Pool();
Object.defineProperties(deferredPostgresPool, {
  connect: {
    value: async () => (await getPostgresPool()).connect(),
  },
  query: {
    value: async (...argumentsList: unknown[]) => {
      const pool = await getPostgresPool();
      return Reflect.apply(pool.query, pool, argumentsList);
    },
  },
});

export function getDeferredPostgresPool() {
  return deferredPostgresPool;
}

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

export function expectedWebDatabaseRole(environment: Record<string, string | undefined> = process.env) {
  const audience = environment.RIVERTON_APP_AUDIENCE?.trim().toLowerCase();
  if (audience === "client") return "agentnovas_client_web";
  if (audience === "operations") return "agentnovas_ops_web";
  if (audience === "maintenance") return "agentnovas_maint_web";
  return null;
}

export function isolatedQualityDatabaseRoleBypass(
  connectionString: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const schema = environment.QUALITY_E2E_SCHEMA?.trim() ?? "";
  if (!/^quality_e2e_[a-z0-9_]{4,42}$/.test(schema)) return false;
  let url: URL;
  try { url = new URL(connectionString); } catch { return false; }
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) return false;
  if (url.searchParams.get("options") !== `-csearch_path=${schema}`) return false;
  const disabledFlags = [
    "PAYMENT_WORKER_ENABLED","PAYMENT_PROVIDER_TESTS_ENABLED","NOTIFICATION_WORKER_ENABLED",
    "NOTIFICATION_EMAIL_SEND_ENABLED","DEMO_EXECUTION_WORKER_ENABLED",
    "PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED","PLATFORM_DEMO_VERIFICATION_ENABLED",
    "STRATEGY_RESEARCH_ENABLED","STRATEGY_RUNTIME_ENABLED",
  ];
  return disabledFlags.every((name) => environment[name] === "false");
}

export async function getPostgresPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const expectedRole = expectedWebDatabaseRole();
      const connectionString = expectedRole ? businessDatabaseUrl() : researchDatabaseUrl();
      if (!connectionString) throw new Error("PostgreSQL RESEARCH_DATABASE_URL 或 DATABASE_URL 尚未配置");
      const qualityRoleBypass = expectedRole && isolatedQualityDatabaseRoleBypass(connectionString);
      if (expectedRole && !qualityRoleBypass) {
        let configuredRole = "";
        try {
          configuredRole = decodeURIComponent(new URL(connectionString).username);
        } catch {
          throw new Error("Web DATABASE_URL 格式无效");
        }
        if (configuredRole !== expectedRole) {
          throw new Error("Web DATABASE_URL 数据库角色与 RIVERTON_APP_AUDIENCE 不匹配");
        }
      }
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
      if (expectedRole && !qualityRoleBypass) {
        const role = await pool.query<{ current_user: string }>("SELECT current_user");
        if (role.rows[0]?.current_user !== expectedRole) {
          await pool.end();
          throw new Error("PostgreSQL 当前角色与应用 audience 不匹配");
        }
      }
      return pool;
    })();
  }
  return poolPromise;
}

export async function getClientAuthPostgresPool() {
  if (!clientAuthPoolPromise) {
    clientAuthPoolPromise = (async () => {
      if (process.env.RIVERTON_APP_AUDIENCE?.trim().toLowerCase() !== "client") {
        throw new Error("Client auth database pool is unavailable outside the Client audience");
      }
      const qualityConnection = businessDatabaseUrl();
      const qualityRoleBypass = isolatedQualityDatabaseRoleBypass(qualityConnection);
      const connectionString = qualityRoleBypass
        ? qualityConnection
        : process.env.CLIENT_AUTH_DATABASE_URL?.trim() ?? "";
      if (!connectionString) throw new Error("CLIENT_AUTH_DATABASE_URL 尚未配置");
      if (!qualityRoleBypass) {
        let configuredRole = "";
        try { configuredRole = decodeURIComponent(new URL(connectionString).username); } catch {
          throw new Error("CLIENT_AUTH_DATABASE_URL 格式无效");
        }
        if (configuredRole !== "agentnovas_client_auth") {
          throw new Error("CLIENT_AUTH_DATABASE_URL 必须使用 agentnovas_client_auth");
        }
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,max: 4,idleTimeoutMillis: 30_000,connectionTimeoutMillis: 5_000,
        application_name: "agentnovas-client-auth",
      });
      pool.on("error", error => {
        console.error("PostgreSQL Client auth idle error", { code: "code" in error ? error.code : "UNKNOWN" });
      });
      if (!qualityRoleBypass) {
        const role = await pool.query<{ current_user: string }>("SELECT current_user");
        if (role.rows[0]?.current_user !== "agentnovas_client_auth") {
          await pool.end();
          throw new Error("Client auth PostgreSQL 当前角色不匹配");
        }
      }
      return pool;
    })();
  }
  return clientAuthPoolPromise;
}

export async function checkPostgresConnection() {
  const pool = await getPostgresPool();
  await pool.query("SELECT 1");
  return true;
}
