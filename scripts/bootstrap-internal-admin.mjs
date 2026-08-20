import pg from "pg";

import { bootstrapInternalAdmin } from "../lib/internal-bootstrap.ts";

if (process.env.ALLOW_INTERNAL_BOOTSTRAP !== "1") {
  throw new Error("必须显式设置 ALLOW_INTERNAL_BOOTSTRAP=1 才能运行一次性内部管理员初始化");
}
const connectionString = process.env.DATABASE_URL?.trim();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
if (!connectionString || !email || !password) {
  throw new Error("DATABASE_URL、BOOTSTRAP_ADMIN_EMAIL、BOOTSTRAP_ADMIN_PASSWORD 均为必填环境变量");
}
const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "agentnovas-internal-bootstrap",
});
try {
  const result = await bootstrapInternalAdmin(pool, { email, password });
  if (!result.ok) {
    process.stderr.write(`初始化未执行：${result.code}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write("内部管理员已创建。以下 MFA 材料只显示一次，请立即存入获授权的密码管理器。\n");
    process.stdout.write(`TOTP_URI=${result.totpUri}\n`);
    process.stdout.write(`RECOVERY_CODES=${result.recoveryCodes.join(",")}\n`);
  }
} finally {
  await pool.end();
}
