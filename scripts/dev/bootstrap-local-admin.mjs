#!/usr/bin/env node
// 本地开发专用：创建第一个内部管理员。
//
// 生产的开户路径是 systemd 凭据脚本（scripts/provision-acceptance-accounts.mjs），
// 它要求 /run/credentials 目录，且需要已存在唯一 active hq_admin。HTTP bootstrap
// 接口已被硬关闭（返回 404），因为「secret 泄露即可重置高权管理员」是一个持续风险。
//
// 本脚本只解决本地开发的鸡生蛋问题，带三重防护：
//   1. DATABASE_URL 必须指向 127.0.0.1 / localhost；
//   2. NODE_ENV 不能是 production；
//   3. 必须显式设置 ALLOW_LOCAL_DEV_BOOTSTRAP=1。
//
// 用法：
//   ALLOW_LOCAL_DEV_BOOTSTRAP=1 node --env-file-if-exists=.env.local \
//     --experimental-strip-types scripts/dev/bootstrap-local-admin.mjs <email> <password>

import pg from "pg";

import { bootstrapInternalAdmin } from "../../lib/internal-bootstrap.ts";

if (process.env.ALLOW_LOCAL_DEV_BOOTSTRAP !== "1") {
  throw new Error("必须显式设置 ALLOW_LOCAL_DEV_BOOTSTRAP=1");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("本脚本仅用于本地开发，禁止在 production 下运行");
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("缺少 DATABASE_URL");

const host = new URL(connectionString.replace(/^postgres(ql)?:/, "http:")).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error(`DATABASE_URL 指向 ${host}，本脚本只允许操作本地数据库`);
}

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  throw new Error("用法：bootstrap-local-admin.mjs <email> <password>");
}
if (password.length < 12) throw new Error("本地开发密码也至少 12 位");

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const result = await bootstrapInternalAdmin(pool, { email, password });
  process.stdout.write("本地管理员已创建：\n");
  process.stdout.write(`  邮箱      ${email}\n`);
  process.stdout.write(`  用户 ID   ${result.userId ?? "(见返回)"}\n`);
  if (result.ok === false) {
    process.stdout.write(`  未创建：${result.code}\n`);
  }
  if (result.totpUri) {
    const secret = new URL(result.totpUri.replace("otpauth://", "http://")).searchParams.get("secret");
    process.stdout.write(`  TOTP 密钥 ${secret}\n`);
    process.stdout.write(`  TOTP URI  ${result.totpUri}\n`);
    process.stdout.write("  内部端（运营/运维）强制 MFA，用 Authenticator 录入上面的密钥。\n");
  }
  if (Array.isArray(result.recoveryCodes) && result.recoveryCodes.length) {
    process.stdout.write("  恢复码：\n");
    for (const code of result.recoveryCodes) process.stdout.write(`    ${code}\n`);
  }
  process.stdout.write("\n以上是本地开发凭据，不要用于任何非本机环境。\n");
} finally {
  await pool.end();
}
