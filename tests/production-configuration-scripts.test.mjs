import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("..", import.meta.url).pathname;

const fixtures = {
  "client.env": `NODE_ENV=production
DATABASE_URL=postgresql://client
CLIENT_AUTH_DATABASE_URL=postgresql://client-auth
TRUST_PROXY_HOPS=1
LLM_PROFILE_ENCRYPTION_KEY=shared-llm-key
MFA_TOTP_ENCRYPTION_KEY=client-mfa-key
MFA_ENFORCEMENT_ENABLED=false
NOTIFICATION_TOKEN_ENCRYPTION_KEY=shared-notification-key
PAYMENT_WORKER_ENABLED=false
UDUN_GATEWAY_BASE_URL=
UDUN_MERCHANT_ID=
UDUN_API_KEY=
UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook
NOTIFICATION_EMAIL_SEND_ENABLED=false
PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false
`,
  "operations.env": `NODE_ENV=production
DATABASE_URL=postgresql://operations
TRUST_PROXY_HOPS=1
MFA_TOTP_ENCRYPTION_KEY=internal-mfa-key
MFA_ENFORCEMENT_ENABLED=false
NOTIFICATION_TOKEN_ENCRYPTION_KEY=shared-notification-key
NOTIFICATION_EMAIL_SEND_ENABLED=false
`,
  "maintenance.env": `NODE_ENV=production
DATABASE_URL=postgresql://maintenance
PAYMENT_WEBHOOK_DATABASE_URL=postgresql://payment-webhook
TRUST_PROXY_HOPS=1
MFA_TOTP_ENCRYPTION_KEY=internal-mfa-key
MFA_ENFORCEMENT_ENABLED=false
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=shared-integration-key
LLM_PROFILE_ENCRYPTION_KEY=shared-llm-key
RESEND_WEBHOOK_SECRET=
PAYMENT_WORKER_ENABLED=false
PAYMENT_PROVIDER_TESTS_ENABLED=false
UDUN_GATEWAY_BASE_URL=
UDUN_MERCHANT_ID=
UDUN_API_KEY=
UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook
NOTIFICATION_EMAIL_SEND_ENABLED=false
DEMO_EXECUTION_WORKER_ENABLED=false
CONFIGURATION_ACTIVATION_WORKER_ENABLED=false
PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false
`,
  "configuration-activation.env": `NODE_ENV=production
CONFIGURATION_ACTIVATION_DATABASE_URL=postgresql://agentnovas_configuration_activation_worker@127.0.0.1:5432/agentnovas
CONFIGURATION_ACTIVATION_WORKER_ENABLED=false
CONFIGURATION_ACTIVATION_WORKER_INTERVAL_MS=5000
CONFIGURATION_ACTIVATION_WORKER_BATCH_SIZE=50
`,
  "notification.env": `NODE_ENV=production
DATABASE_URL=postgresql://notification
NOTIFICATION_WORKER_ENABLED=true
NOTIFICATION_EMAIL_SEND_ENABLED=false
NOTIFICATION_EMAIL_ALLOWLIST=
NOTIFICATION_TOKEN_ENCRYPTION_KEY=shared-notification-key
RESEND_API_KEY=
`,
  "runtime.env": `NODE_ENV=production
RESEARCH_DATABASE_URL=postgresql://runtime
LLM_PROFILE_ENCRYPTION_KEY=shared-llm-key
STRATEGY_RUNTIME_ENABLED=false
`,
  "demo.env": `NODE_ENV=production
DATABASE_URL=postgresql://demo
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=shared-integration-key
DEMO_EXECUTION_WORKER_ENABLED=false
PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false
`,
  "migrator.env": `NODE_ENV=production
DATABASE_URL=postgresql://migrator
POSTGRES_MIGRATION_SCHEMA=public
GIT_COMMIT_SHA=test
`,
  // 执行服务：全系统唯一持有交易所凭证解密能力的进程。配置审计必须检查它，
  // 否则漏配这一份的后果是客户点「验证交易所账户」和「一键平仓」都报服务不可用。
  "execution.env": `NODE_ENV=production
DATABASE_URL=postgresql://agentnovas_execution_service@127.0.0.1:5432/agentnovas
RIVERTON_EXECUTION_SERVICE=true
EXCHANGE_CREDENTIAL_ENCRYPTION_KEY=test-exchange-key
EXECUTION_SERVICE_SHARED_SECRET=test-shared-secret-0123456789abcdef0123456789
EXECUTION_SERVICE_HOST=127.0.0.1
EXECUTION_SERVICE_PORT=3020
GIT_COMMIT_SHA=test
`,
};

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-config-test-"));
  for (const [name, body] of Object.entries(fixtures)) {
    await writeFile(join(directory, name), body, { mode: 0o440 });
    await chmod(join(directory, name), 0o440);
  }
  return directory;
}

async function run(script, arguments_, environment) {
  return execFileAsync("bash", [join(repositoryRoot, script), ...arguments_], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
  });
}

async function replaceEnvValue(directory, fileName, key, value) {
  const path = join(directory, fileName);
  const body = await readFile(path, "utf8");
  const line = new RegExp(`^${key}=.*$`, "m");
  assert.match(body, line);
  await chmod(path, 0o600);
  await writeFile(path, body.replace(line, `${key}=${value}`), { mode: 0o440 });
  await chmod(path, 0o440);
}

async function removeEnvValue(directory, fileName, key) {
  const path = join(directory, fileName);
  const body = await readFile(path, "utf8");
  const line = new RegExp(`^${key}=.*\\n?`, "m");
  assert.match(body, line);
  await chmod(path, 0o600);
  await writeFile(path, body.replace(line, ""), { mode: 0o440 });
  await chmod(path, 0o440);
}

test("the production audit reports readiness facts without exposing configuration values", async () => {
  const directory = await fixtureDirectory();
  try {
    const result = await run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory });
    assert.match(result.stdout, /core_configuration=ready/);
    assert.match(result.stdout, /resend_configuration=incomplete/);
    assert.match(result.stdout, /udun_configuration=incomplete/);
    assert.match(result.stdout, /notification_email_send=disabled/);
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\/|shared-notification-key|shared-llm-key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production audit requires an explicit MFA rollout state in every web application", async () => {
  for (const fileName of ["client.env", "operations.env", "maintenance.env"]) {
    const directory = await fixtureDirectory();
    try {
      await removeEnvValue(directory, fileName, "MFA_ENFORCEMENT_ENABLED");
      await assert.rejects(
        run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory }),
        (error) => error.stderr.includes(`${fileName}:MFA_ENFORCEMENT_ENABLED:missing_or_duplicate`),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the production audit accepts only exact boolean MFA rollout states", async () => {
  for (const invalidValue of ["TRUE", "1", " true", "false "]) {
    const directory = await fixtureDirectory();
    try {
      await replaceEnvValue(directory, "client.env", "MFA_ENFORCEMENT_ENABLED", invalidValue);
      await assert.rejects(
        run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory }),
        (error) => error.stderr.includes("client.env:MFA_ENFORCEMENT_ENABLED:must_be_true_or_false"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the production audit requires the same MFA rollout state across all three applications", async () => {
  for (const [fileName, finding] of [
    ["operations.env", "mfa_enforcement_client_operations:mismatch"],
    ["maintenance.env", "mfa_enforcement_client_maintenance:mismatch"],
  ]) {
    const directory = await fixtureDirectory();
    try {
      await replaceEnvValue(directory, fileName, "MFA_ENFORCEMENT_ENABLED", "true");
      await assert.rejects(
        run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory }),
        (error) => error.stderr.includes(finding),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the production audit rejects a configuration Worker DSN using another database role", async () => {
  const directory = await fixtureDirectory();
  try {
    await replaceEnvValue(
      directory,
      "configuration-activation.env",
      "CONFIGURATION_ACTIVATION_DATABASE_URL",
      "postgresql://agentnovas_maint_web@127.0.0.1:5432/agentnovas",
    );
    await assert.rejects(
      run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory }),
      (error) => error.stderr.includes("configuration-activation.env:CONFIGURATION_ACTIVATION_DATABASE_URL:dedicated_role_required"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the fill-in installer validates and atomically places provider secrets while retaining safety gates", async () => {
  const directory = await fixtureDirectory();
  const answerFile = join(directory, "production-integrations.answers");
  const resendKey = "re_test_only_rotated_key_123456789";
  const webhookSecret = "whsec_test_only_webhook_secret_123456789";
  const udunKey = "udun-test-only-api-key-123456789";
  await writeFile(answerFile, `RESEND_API_KEY=${resendKey}
RESEND_WEBHOOK_SECRET=${webhookSecret}
NOTIFICATION_EMAIL_ALLOWLIST=acceptance@example.test
UDUN_GATEWAY_BASE_URL=https://sig11.udun.io
UDUN_MERCHANT_ID=123456
UDUN_API_KEY=${udunKey}
UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook
`, { mode: 0o600 });
  await chmod(answerFile, 0o600);
  try {
    const checked = await run("scripts/install-production-integrations.sh", ["--check", answerFile], { RIVERTON_SECRET_DIR: directory });
    assert.match(checked.stdout, /resend_input=complete/);
    assert.match(checked.stdout, /udun_input=complete/);
    assert.doesNotMatch(checked.stdout + checked.stderr, new RegExp([resendKey, webhookSecret, udunKey].join("|")));

    const applied = await run("scripts/install-production-integrations.sh", ["--apply", answerFile], { RIVERTON_SECRET_DIR: directory });
    assert.match(applied.stdout, /configuration_update=applied/);
    assert.doesNotMatch(applied.stdout + applied.stderr, new RegExp([resendKey, webhookSecret, udunKey].join("|")));

    const client = await readFile(join(directory, "client.env"), "utf8");
    const maintenance = await readFile(join(directory, "maintenance.env"), "utf8");
    const notification = await readFile(join(directory, "notification.env"), "utf8");
    assert.match(client, new RegExp(`^UDUN_API_KEY=${udunKey}$`, "m"));
    assert.match(maintenance, new RegExp(`^UDUN_API_KEY=${udunKey}$`, "m"));
    assert.match(notification, new RegExp(`^RESEND_API_KEY=${resendKey}$`, "m"));
    assert.match(maintenance, new RegExp(`^RESEND_WEBHOOK_SECRET=${webhookSecret}$`, "m"));
    assert.doesNotMatch(client, /RESEND_API_KEY|RESEND_WEBHOOK_SECRET/);
    for (const body of [client, maintenance, notification]) {
      assert.match(body, /^NOTIFICATION_EMAIL_SEND_ENABLED=false$/m);
    }
    assert.match(client, /^PAYMENT_WORKER_ENABLED=false$/m);
    assert.match(maintenance, /^PAYMENT_WORKER_ENABLED=false$/m);
    assert.match(maintenance, /^PAYMENT_PROVIDER_TESTS_ENABLED=false$/m);
    assert.match(client, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);
    assert.match(maintenance, /^PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false$/m);

    const audited = await run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory });
    assert.match(audited.stdout, /resend_configuration=ready/);
    assert.match(audited.stdout, /udun_configuration=ready/);
    assert.match(audited.stdout, /notification_email_send=disabled/);
    assert.doesNotMatch(audited.stdout + audited.stderr, new RegExp([resendKey, webhookSecret, udunKey].join("|")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the installer rejects permissive answer-file modes and duplicate or unknown keys", async () => {
  const directory = await fixtureDirectory();
  const answerFile = join(directory, "unsafe.answers");
  try {
    await writeFile(answerFile, "RESEND_API_KEY=re_test_only\nRESEND_API_KEY=re_duplicate\n", { mode: 0o644 });
    await chmod(answerFile, 0o644);
    await assert.rejects(
      run("scripts/install-production-integrations.sh", ["--check", answerFile], { RIVERTON_SECRET_DIR: directory }),
      (error) => /permissions must be 0400 or 0600/i.test(error.stderr),
    );
    await chmod(answerFile, 0o600);
    await assert.rejects(
      run("scripts/install-production-integrations.sh", ["--check", answerFile], { RIVERTON_SECRET_DIR: directory }),
      (error) => /duplicate key/i.test(error.stderr),
    );
    await writeFile(answerFile, "UNSUPPORTED_SECRET=value\n", { mode: 0o600 });
    await assert.rejects(
      run("scripts/install-production-integrations.sh", ["--check", answerFile], { RIVERTON_SECRET_DIR: directory }),
      (error) => /unsupported key/i.test(error.stderr),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
