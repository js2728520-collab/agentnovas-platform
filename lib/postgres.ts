import pg from "pg";
import type { Pool } from "pg";

let poolPromise: Promise<Pool> | undefined;
let clientAuthPoolPromise: Promise<Pool> | undefined;
let paymentWebhookPoolPromise: Promise<Pool> | undefined;
let demoExecutionPoolPromise: Promise<Pool> | undefined;
let releaseControlPoolPromise: Promise<Pool> | undefined;
let releaseIdentityVerifierPoolPromise: Promise<Pool> | undefined;
let aiSecretBrokerPoolPromise: Promise<Pool> | undefined;
let aiGatewayPoolPromise: Promise<Pool> | undefined;

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

/**
 * 执行服务的数据库身份。
 *
 * 它不是三个 Web audience 中的任何一个——它是第四类进程，唯一持有凭证解密密钥。
 * 让它冒用 client 角色就等于放弃了「角色 ↔ 进程身份」这条控制：一旦复用，
 * 数据库层面再也分不清「客户端 Web 读了凭证密文」和「执行服务读了凭证密文」。
 *
 * 独立角色也是后续把 exchange_accounts.encrypted_credential_ref 的列权限从三个
 * Web 角色上收回的前提——那一步之后，Web 层连密文都取不到，「拿不到凭证」将由
 * 数据库强制，而不再依赖构建产物的洁净（ADR-0019）。
 */
export function expectedExecutionDatabaseRole(
  environment: Record<string, string | undefined> = process.env,
) {
  return environment.RIVERTON_EXECUTION_SERVICE === "true" ? "agentnovas_execution_service" : null;
}

function configuredDatabaseRole(connectionString: string, label: string) {
  try {
    return decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error(`${label} 格式无效`);
  }
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

export function resolveWebDatabaseConfiguration(
  environment: Record<string, string | undefined> = process.env,
) {
  const expectedRole = expectedExecutionDatabaseRole(environment) ?? expectedWebDatabaseRole(environment);
  if (!expectedRole) {
    throw new Error("RIVERTON_APP_AUDIENCE 必须明确配置为 client、operations 或 maintenance；执行服务请设置 RIVERTON_EXECUTION_SERVICE=true");
  }
  const connectionString = businessDatabaseUrl(environment);
  if (!connectionString) throw new Error("Web DATABASE_URL 尚未配置");
  const qualityRoleBypass = isolatedQualityDatabaseRoleBypass(connectionString, environment);
  if (!qualityRoleBypass && configuredDatabaseRole(connectionString, "Web DATABASE_URL") !== expectedRole) {
    throw new Error("Web DATABASE_URL 数据库角色与 RIVERTON_APP_AUDIENCE 不匹配");
  }
  return { connectionString, expectedRole, qualityRoleBypass };
}

export async function getPostgresPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const { connectionString, expectedRole, qualityRoleBypass } = resolveWebDatabaseConfiguration();
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
      if (!qualityRoleBypass) {
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

async function isolatedServicePool(input: {
  connectionString: string;
  expectedRole: string;
  applicationName: string;
  maximumConnections: number;
}) {
  if (!input.connectionString) throw new Error(`${input.applicationName} database URL is not configured`);
  if (configuredDatabaseRole(input.connectionString,input.applicationName) !== input.expectedRole) {
    throw new Error(`${input.applicationName} database role is invalid`);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: input.connectionString,
    max: input.maximumConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: input.applicationName,
  });
  const role = await pool.query<{ current_user: string }>("SELECT current_user");
  if (role.rows[0]?.current_user !== input.expectedRole) {
    await pool.end();
    throw new Error(`${input.applicationName} PostgreSQL current role is invalid`);
  }
  return pool;
}

export async function getAiSecretBrokerPostgresPool() {
  if (process.env.AI_SECRET_BROKER_PROCESS !== "true") throw new Error("AI Secret Broker process boundary is disabled");
  aiSecretBrokerPoolPromise ??= isolatedServicePool({
    connectionString: process.env.AI_SECRET_BROKER_DATABASE_URL?.trim() ?? "",
    expectedRole: "agentnovas_ai_secret_broker",
    applicationName: "agentnovas-ai-secret-broker",
    maximumConnections: 2,
  });
  return aiSecretBrokerPoolPromise;
}

export async function getAiGatewayPostgresPool() {
  if (process.env.AI_GATEWAY_PROCESS !== "true") throw new Error("AI Gateway process boundary is disabled");
  aiGatewayPoolPromise ??= isolatedServicePool({
    connectionString: process.env.AI_GATEWAY_DATABASE_URL?.trim() ?? "",
    expectedRole: "agentnovas_ai_gateway",
    applicationName: "agentnovas-ai-gateway",
    maximumConnections: 8,
  });
  return aiGatewayPoolPromise;
}

export async function getDemoExecutionPostgresPool() {
  if (!demoExecutionPoolPromise) {
    demoExecutionPoolPromise = (async () => {
      const connectionString = businessDatabaseUrl();
      if (!connectionString) throw new Error("Demo execution DATABASE_URL 尚未配置");
      const expectedRole = "agentnovas_demo_execution_worker";
      if (configuredDatabaseRole(connectionString, "Demo execution DATABASE_URL") !== expectedRole) {
        throw new Error("Demo execution DATABASE_URL 必须使用 agentnovas_demo_execution_worker");
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,max: 6,idleTimeoutMillis: 30_000,connectionTimeoutMillis: 5_000,
        application_name: "agentnovas-demo-execution-worker",
      });
      pool.on("error", error => {
        console.error("PostgreSQL Demo execution idle error", { code: "code" in error ? error.code : "UNKNOWN" });
      });
      const role = await pool.query<{ current_user: string }>("SELECT current_user");
      if (role.rows[0]?.current_user !== expectedRole) {
        await pool.end();
        throw new Error("Demo execution PostgreSQL 当前角色不匹配");
      }
      return pool;
    })();
  }
  return demoExecutionPoolPromise;
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

export async function getPaymentWebhookPostgresPool() {
  if (!paymentWebhookPoolPromise) {
    paymentWebhookPoolPromise = (async () => {
      if (process.env.RIVERTON_APP_AUDIENCE?.trim().toLowerCase() !== "maintenance") {
        throw new Error("Payment webhook database pool is unavailable outside the Maintenance audience");
      }
      const qualityConnection = businessDatabaseUrl();
      const qualityRoleBypass = isolatedQualityDatabaseRoleBypass(qualityConnection);
      const connectionString = qualityRoleBypass ? qualityConnection : process.env.PAYMENT_WEBHOOK_DATABASE_URL?.trim() ?? "";
      if (!connectionString) throw new Error("PAYMENT_WEBHOOK_DATABASE_URL 尚未配置");
      if (!qualityRoleBypass) {
        let configuredRole = "";
        try { configuredRole = decodeURIComponent(new URL(connectionString).username); } catch {
          throw new Error("PAYMENT_WEBHOOK_DATABASE_URL 格式无效");
        }
        if (configuredRole !== "agentnovas_payment_webhook") {
          throw new Error("PAYMENT_WEBHOOK_DATABASE_URL 必须使用 agentnovas_payment_webhook");
        }
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString, max: 6, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: "agentnovas-payment-webhook" });
      pool.on("error", error => console.error("PostgreSQL payment webhook idle error", { code: "code" in error ? error.code : "UNKNOWN" }));
      if (!qualityRoleBypass) {
        const role = await pool.query<{ current_user: string }>("SELECT current_user");
        if (role.rows[0]?.current_user !== "agentnovas_payment_webhook") {
          await pool.end();
          throw new Error("Payment webhook PostgreSQL 当前角色不匹配");
        }
      }
      return pool;
    })();
  }
  return paymentWebhookPoolPromise;
}

export async function getReleaseControlPostgresPool() {
  if (!releaseControlPoolPromise) {
    releaseControlPoolPromise = (async () => {
      if (process.env.RIVERTON_RELEASE_CONTROL_SERVICE !== "true") {
        throw new Error("Release control database pool is unavailable outside the isolated control service");
      }
      const qualityConnection = businessDatabaseUrl();
      const qualityRoleBypass = isolatedQualityDatabaseRoleBypass(qualityConnection);
      const connectionString = qualityRoleBypass
        ? qualityConnection
        : process.env.RELEASE_CONTROL_DATABASE_URL?.trim() ?? "";
      if (!connectionString) throw new Error("RELEASE_CONTROL_DATABASE_URL 尚未配置");
      if (!qualityRoleBypass && configuredDatabaseRole(connectionString, "Release control DATABASE_URL") !== "agentnovas_release_control") {
        throw new Error("RELEASE_CONTROL_DATABASE_URL 必须使用 agentnovas_release_control");
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,max: 4,idleTimeoutMillis: 30_000,connectionTimeoutMillis: 5_000,
        application_name: "agentnovas-release-control",
      });
      pool.on("error", error => console.error("PostgreSQL release control idle error", { code: "code" in error ? error.code : "UNKNOWN" }));
      if (!qualityRoleBypass) {
        const role = await pool.query<{ current_user: string }>("SELECT current_user");
        if (role.rows[0]?.current_user !== "agentnovas_release_control") {
          await pool.end();
          throw new Error("Release control PostgreSQL 当前角色不匹配");
        }
      }
      return pool;
    })();
  }
  return releaseControlPoolPromise;
}

export async function getReleaseIdentityVerifierPostgresPool() {
  if (!releaseIdentityVerifierPoolPromise) {
    releaseIdentityVerifierPoolPromise = (async () => {
      if (process.env.RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE !== "true") {
        throw new Error("Release identity verifier database pool is unavailable outside the isolated verifier service");
      }
      const qualityConnection = businessDatabaseUrl();
      const qualityRoleBypass = isolatedQualityDatabaseRoleBypass(qualityConnection);
      const connectionString = qualityRoleBypass
        ? qualityConnection
        : process.env.RELEASE_IDENTITY_VERIFIER_DATABASE_URL?.trim() ?? "";
      if (!connectionString) throw new Error("RELEASE_IDENTITY_VERIFIER_DATABASE_URL 尚未配置");
      if (!qualityRoleBypass && configuredDatabaseRole(connectionString, "Release identity verifier DATABASE_URL") !== "agentnovas_release_identity_verifier") {
        throw new Error("RELEASE_IDENTITY_VERIFIER_DATABASE_URL 必须使用 agentnovas_release_identity_verifier");
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString,max: 4,idleTimeoutMillis: 30_000,connectionTimeoutMillis: 5_000,
        application_name: "agentnovas-release-identity-verifier",
      });
      pool.on("error", error => console.error("PostgreSQL release identity verifier idle error", { code: "code" in error ? error.code : "UNKNOWN" }));
      if (!qualityRoleBypass) {
        const role = await pool.query<{ current_user: string }>("SELECT current_user");
        if (role.rows[0]?.current_user !== "agentnovas_release_identity_verifier") {
          await pool.end();
          throw new Error("Release identity verifier PostgreSQL 当前角色不匹配");
        }
      }
      return pool;
    })();
  }
  return releaseIdentityVerifierPoolPromise;
}

export async function checkPostgresConnection() {
  const pool = await getPostgresPool();
  await pool.query("SELECT 1");
  return true;
}
