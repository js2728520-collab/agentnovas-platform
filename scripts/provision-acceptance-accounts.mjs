import { open, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { provisionAcceptanceAccounts } from "../lib/acceptance-account-provisioning.ts";
import { randomToken } from "../lib/auth.ts";

if (process.env.ALLOW_ACCEPTANCE_ACCOUNT_PROVISIONING !== "1") {
  throw new Error("必须显式设置 ALLOW_ACCEPTANCE_ACCOUNT_PROVISIONING=1 才能创建三端验收账号");
}

const connectionString = process.env.DATABASE_URL?.trim();
const outputInput = process.env.ACCEPTANCE_CREDENTIAL_OUTPUT?.trim();
const emails = {
  client: process.env.ACCEPTANCE_CLIENT_EMAIL?.trim(),
  operations: process.env.ACCEPTANCE_OPERATIONS_EMAIL?.trim(),
  maintenance: process.env.ACCEPTANCE_MAINTENANCE_EMAIL?.trim(),
};
if (!connectionString || !outputInput || Object.values(emails).some((email) => !email)) {
  throw new Error("DATABASE_URL、ACCEPTANCE_CREDENTIAL_OUTPUT 和三端 ACCEPTANCE_*_EMAIL 均为必填环境变量");
}

const credentialDirectory = await realpath("/run/credentials");
const outputPath = resolve(outputInput);
if (await realpath(dirname(outputPath)) !== credentialDirectory
  || dirname(outputPath) !== credentialDirectory
  || !/^three-app-credentials-[A-Za-z0-9._-]+\.json$/.test(outputPath.slice(credentialDirectory.length + 1))) {
  throw new Error("ACCEPTANCE_CREDENTIAL_OUTPUT 必须是 /run/credentials/three-app-credentials-*.json");
}

const passwords = {
  client: randomToken(24),
  operations: randomToken(24),
  maintenance: randomToken(24),
};
const credentials = {
  client: { email: emails.client, password: passwords.client },
  operations: { email: emails.operations, password: passwords.operations },
  maintenance: { email: emails.maintenance, password: passwords.maintenance },
};
const credentialDocument = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  handling: "Store in an authorized password manager, rotate passwords after first login, then securely delete this file.",
  accounts: {
    client: {
      email: credentials.client.email,
      password: credentials.client.password,
      loginUrl: "https://agentnovas.com/login",
      mfa: "Optional; enrollment is available in account security settings.",
    },
    operations: {
      email: credentials.operations.email,
      password: credentials.operations.password,
      loginUrl: "https://zht.agentnovas.com/login",
      mfa: "TOTP enrollment is required immediately after primary authentication.",
    },
    maintenance: {
      email: credentials.maintenance.email,
      password: credentials.maintenance.password,
      loginUrl: "https://xm.agentnovas.com/login",
      mfa: "TOTP enrollment is required immediately after primary authentication.",
    },
  },
};

const openOptions = { flag: "wx", mode: 0o600 };
const credentialFile = await open(outputPath, openOptions.flag, openOptions.mode);
let committed = false;
const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "agentnovas-acceptance-account-provisioning",
});
try {
  await credentialFile.writeFile(`${JSON.stringify(credentialDocument, null, 2)}\n`, "utf8");
  await credentialFile.sync();
  await provisionAcceptanceAccounts(pool, credentials);
  committed = true;
  process.stdout.write("三端验收账号已创建；凭证仅写入受保护文件。\n");
  process.stdout.write(`CREDENTIAL_FILE=${outputPath}\n`);
} finally {
  await pool.end();
  await credentialFile.close();
  if (!committed) await unlink(outputPath).catch(() => undefined);
}
