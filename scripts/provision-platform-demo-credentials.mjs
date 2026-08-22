import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { provisionPlatformDemoCredentials } from "../lib/platform-demo-credential-provisioning.ts";

if (process.env.ALLOW_PLATFORM_DEMO_CREDENTIAL_PROVISIONING !== "1") {
  throw new Error("必须显式设置 ALLOW_PLATFORM_DEMO_CREDENTIAL_PROVISIONING=1 才能录入 Demo 凭证");
}
const connectionString = process.env.DATABASE_URL?.trim();
const inputValue = process.env.PLATFORM_DEMO_CREDENTIAL_INPUT?.trim();
if (!connectionString || !inputValue) {
  throw new Error("DATABASE_URL 和 PLATFORM_DEMO_CREDENTIAL_INPUT 均为必填");
}

const credentialDirectory = await realpath("/run/credentials");
const inputPath = resolve(inputValue);
if (dirname(inputPath) !== credentialDirectory
  || await realpath(dirname(inputPath)) !== credentialDirectory
  || await realpath(inputPath) !== inputPath
  || inputPath !== `${credentialDirectory}/platform-demo-accounts.json`) {
  throw new Error("PLATFORM_DEMO_CREDENTIAL_INPUT 必须是 /run/credentials/platform-demo-accounts.json 且不能是符号链接");
}
const fileState = await lstat(inputPath);
const mode = fileState.mode & 0o777;
if (!fileState.isFile() || (mode !== 0o400 && mode !== 0o600) || fileState.size > 65_536) {
  throw new Error("Demo 凭证文件必须是 0400/0600 普通文件且不超过 64 KiB");
}

const parsed = JSON.parse(await readFile(inputPath, "utf8"));
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
  || parsed.schemaVersion !== 1 || !parsed.accounts
  || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts)
  || Object.keys(parsed).some((key) => !["schemaVersion", "accounts"].includes(key))
  || Object.keys(parsed.accounts).some((key) => !["okx", "binance", "bybit"].includes(key))) {
  throw new Error("Demo 凭证文件结构无效");
}
for (const [provider, credential] of Object.entries(parsed.accounts)) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)
    || Object.keys(credential).some((key) => !["label", "apiKey", "secret", "passphrase"].includes(key))) {
    throw new Error(`Demo ${provider} 凭证结构无效`);
  }
}

const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "agentnovas-platform-demo-credential-provisioning",
});
try {
  const result = await provisionPlatformDemoCredentials(pool, parsed.accounts);
  process.stdout.write(`PLATFORM_DEMO_PROVIDERS_PROVISIONED=${result.providers.join(",")}\n`);
  process.stdout.write("PLATFORM_DEMO_ACCOUNTS_ENABLED=false\n");
  process.stdout.write("PLATFORM_DEMO_KILL_SWITCHES=enabled\n");
  process.stdout.write("PLATFORM_DEMO_EXTERNAL_WRITES=unchanged\n");
} finally {
  await pool.end();
}
