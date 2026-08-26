#!/usr/bin/env node
// 本地开发专用：创建三端与 Worker 的数据库角色。
//
// 应用会强制校验「连接串里的数据库角色必须与 RIVERTON_APP_AUDIENCE 匹配」
// （lib/postgres.ts:resolveWebDatabaseConfiguration），迁移 0040/0043 的 RLS 策略
// 也按 current_user 判定。所以本地必须建出真实角色，用超级用户连是跑不起来的——
// 这是好事：本地跑的就是生产那套角色与 RLS 边界。
//
// 注意：本脚本给的是「够跑起来」的授权，不是生产加固配置。生产角色的最小权限
// 由 scripts/release/postgres-role-policy.mjs 校验，两者不要混用。
//
// 防护：仅限本地数据库、非 production、需显式开关。
//
// 用法：
//   ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local \
//     --experimental-strip-types scripts/dev/provision-local-roles.mjs

import pg from "pg";

if (process.env.ALLOW_LOCAL_DEV_BOOTSTRAP !== "1") {
  throw new Error("必须显式设置 ALLOW_LOCAL_DEV_BOOTSTRAP=1");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("本脚本仅用于本地开发，禁止在 production 下运行");
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("缺少 DATABASE_URL");

const url = new URL(connectionString.replace(/^postgres(ql)?:/, "http:"));
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
  throw new Error(`DATABASE_URL 指向 ${url.hostname}，本脚本只允许操作本地数据库`);
}

// 本地开发口令。生产口令由运维单独下发，不在代码或脚本里出现。
const LOCAL_PASSWORD = process.env.LOCAL_DB_ROLE_PASSWORD?.trim() || "localdev";

// agentnovas_execution_service 不是 Web 角色，但本地授权形状与它们相同，
// 一起建最省事。生产环境的最小权限见 postgres-role-policy.mjs。
const WEB_ROLES = ["agentnovas_client_web", "agentnovas_client_auth", "agentnovas_ops_web", "agentnovas_maint_web", "agentnovas_execution_service"];
const WORKER_ROLES = [
  "agentnovas_migrator",
  "agentnovas_runtime_worker",
  "agentnovas_notification_worker",
  "agentnovas_demo_execution_worker",
  "agentnovas_payment_webhook",
];
const ALL_ROLES = [...WEB_ROLES, ...WORKER_ROLES];

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const database = url.pathname.replace(/^\//, "");
  for (const role of ALL_ROLES) {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} LOGIN PASSWORD '${LOCAL_PASSWORD}';
        ELSE
          ALTER ROLE ${role} LOGIN PASSWORD '${LOCAL_PASSWORD}';
        END IF;
      END $$;
    `);
    await pool.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    // 迁移之后新建的对象也要能访问，否则加一张表就要重跑一次。
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    process.stdout.write(`  ✓ ${role}\n`);
  }
  process.stdout.write(`\n已创建 ${ALL_ROLES.length} 个本地角色，口令统一为 ${LOCAL_PASSWORD}。\n`);
  process.stdout.write("三端各自的 DATABASE_URL 需要用对应角色，例如：\n");
  for (const role of WEB_ROLES.slice(0, 3)) {
    process.stdout.write(`  postgresql://${role}:${LOCAL_PASSWORD}@127.0.0.1:5432/${database}\n`);
  }
} finally {
  await pool.end();
}
