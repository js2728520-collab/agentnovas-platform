import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
PAYMENT_PROVIDER_OUTBOUND_ENABLED=false
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
RELEASE_IDENTITY_VERIFIER_URL=http://127.0.0.1:3315
RELEASE_IDENTITY_VERIFIER_SHARED_SECRET=release-identity-shared-secret-at-least-48-characters
RELEASE_CONTROL_GATEWAY_URL=http://127.0.0.1:3314
RELEASE_CONTROL_GATEWAY_SHARED_SECRET=release-control-shared-secret-at-least-48-characters
PAYMENT_WEBHOOK_DATABASE_URL=postgresql://payment-webhook
TRUST_PROXY_HOPS=1
MFA_TOTP_ENCRYPTION_KEY=internal-mfa-key
MFA_ENFORCEMENT_ENABLED=false
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=shared-integration-key
LLM_PROFILE_ENCRYPTION_KEY=shared-llm-key
RESEND_WEBHOOK_SECRET=
PAYMENT_WORKER_ENABLED=false
PAYMENT_PROVIDER_TESTS_ENABLED=false
PAYMENT_PROVIDER_OUTBOUND_ENABLED=false
UDUN_GATEWAY_BASE_URL=
UDUN_MERCHANT_ID=
UDUN_API_KEY=
UDUN_CALLBACK_URL=https://xm.agentnovas.com/api/integrations/payments/udun/webhook
NOTIFICATION_EMAIL_SEND_ENABLED=false
DEMO_EXECUTION_WORKER_ENABLED=false
CONFIGURATION_ACTIVATION_WORKER_ENABLED=false
PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED=false
`,
  "release-control.env": `NODE_ENV=production
RIVERTON_RELEASE_CONTROL_SERVICE=true
RELEASE_CONTROL_ENABLED=false
RELEASE_CONTROL_DATABASE_URL=postgresql://agentnovas_release_control@127.0.0.1:5432/agentnovas
RELEASE_CONTROL_GATEWAY_SHARED_SECRET=release-control-shared-secret-at-least-48-characters
`,
  "release-identity-verifier.env": `NODE_ENV=production
RIVERTON_RELEASE_IDENTITY_VERIFIER_SERVICE=true
RELEASE_IDENTITY_VERIFIER_ENABLED=false
RELEASE_IDENTITY_VERIFIER_DATABASE_URL=postgresql://agentnovas_release_identity_verifier@127.0.0.1:5432/agentnovas
RELEASE_IDENTITY_VERIFIER_SHARED_SECRET=release-identity-shared-secret-at-least-48-characters
RELEASE_IDENTITY_VERIFIER_WEBAUTHN_POLICY_FILE=/run/secrets/release-identity-verifier-webauthn-policy.json
`,
  "configuration-activation.env": `NODE_ENV=production
CONFIGURATION_ACTIVATION_DATABASE_URL=postgresql://agentnovas_configuration_activation_worker@127.0.0.1:5432/agentnovas
CONFIGURATION_ACTIVATION_WORKER_ENABLED=false
CONFIGURATION_ACTIVATION_WORKER_INTERVAL_MS=5000
CONFIGURATION_ACTIVATION_WORKER_BATCH_SIZE=50
`,
  "release-orchestrator-staging.env": `NODE_ENV=production
RELEASE_ORCHESTRATOR_WORKER_ENABLED=false
RELEASE_ORCHESTRATOR_DATABASE_URL=postgresql://agentnovas_release_worker@127.0.0.1:5432/agentnovas
RELEASE_ORCHESTRATOR_BINDING_FILE=/run/secrets/release-orchestrator-binding.json
RELEASE_ORCHESTRATOR_WORKER_ID=release-worker-staging-test
RELEASE_ORCHESTRATOR_INTERVAL_MS=30000
RELEASE_ORCHESTRATOR_LEASE_SECONDS=300
`,
  "release-auditor-staging.env": `NODE_ENV=production
RELEASE_AUDITOR_ENABLED=false
RELEASE_AUDITOR_DATABASE_URL=postgresql://agentnovas_release_auditor@127.0.0.1:5432/agentnovas
RELEASE_AUDITOR_HOST=127.0.0.1
RELEASE_AUDITOR_PORT=3316
`,
  "release-webhook.env": `NODE_ENV=production
RELEASE_WEBHOOK_INGRESS_ENABLED=false
RELEASE_WEBHOOK_DATABASE_URL=postgresql://agentnovas_release_ingress@127.0.0.1:5432/agentnovas
RELEASE_WEBHOOK_BINDING_FILE=/run/secrets/release-webhook-binding.json
RELEASE_WEBHOOK_HOST=127.0.0.1
RELEASE_WEBHOOK_PORT=3004
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

fixtures["release-orchestrator-production.env"] = fixtures["release-orchestrator-staging.env"]
  .replace("release-worker-staging-test", "release-worker-production-test");
fixtures["release-auditor-production.env"] = fixtures["release-auditor-staging.env"]
  .replace("RELEASE_AUDITOR_PORT=3316", "RELEASE_AUDITOR_PORT=3317");

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

async function installManagedEmailFixture(directory) {
  const keyId = "email-broker-testkey12345678";
  const managed = join(directory, "email-managed");
  const versions = join(managed, "versions");
  const version = "email-20260829T120000000Z-test12345678";
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const notificationFile = `versions/${version}.notification.env`;
  const maintenanceFile = `versions/${version}.maintenance.env`;
  const notificationContent = `EMAIL_SECRET_CONFIGURATION_VERSION=${version}\nRESEND_API_KEY=re_managed_test_only_123456789\n`;
  const maintenanceContent = `EMAIL_SECRET_CONFIGURATION_VERSION=${version}\nRESEND_WEBHOOK_SECRET=whsec_managed_test_only_123456789\n`;
  await writeFile(join(managed, notificationFile), notificationContent, { mode: 0o600 });
  await writeFile(join(managed, maintenanceFile), maintenanceContent, { mode: 0o600 });
  const manifest = {
    schemaVersion: "1",
    version,
    notification: { file: notificationFile, sha256: createHash("sha256").update(notificationContent).digest("hex") },
    maintenance: { file: maintenanceFile, sha256: createHash("sha256").update(maintenanceContent).digest("hex") },
  };
  await writeFile(join(managed, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "email-secret-broker.env"), `NODE_ENV=production
DATABASE_URL=postgresql://agentnovas_email_secret_broker:test-only@postgres:5432/agentnovas
EMAIL_SECRET_BROKER_ENABLED=true
EMAIL_SECRET_BROKER_KEY_ID=${keyId}
EMAIL_SECRET_BROKER_PRIVATE_KEY_PATH=/run/secrets/email-secret-broker-private.pem
EMAIL_SECRET_DIRECTORY=/run/email-secrets
`, { mode: 0o440 });
  await writeFile(join(directory, "email-secret-broker-private.pem"), "test-only-private-key\n", { mode: 0o400 });
  await writeFile(join(directory, "email-secret-broker-public.pem"), "test-only-public-key\n", { mode: 0o444 });
  for (const fileName of ["maintenance.env", "notification.env"]) {
    const path = join(directory, fileName);
    const body = await readFile(path, "utf8");
    const additions = fileName === "maintenance.env"
      ? `EMAIL_SECRET_BROKER_KEY_ID=${keyId}\nEMAIL_SECRET_BROKER_PUBLIC_KEY_PATH=/run/secrets/email-secret-broker-public.pem\nEMAIL_SECRET_DIRECTORY=/run/email-secrets\nEMAIL_TEST_RECIPIENT_ENCRYPTION_KEY=test-recipient-key-at-least-thirty-two-bytes\n`
      : "EMAIL_SECRET_DIRECTORY=/run/email-secrets\nEMAIL_TEST_RECIPIENT_ENCRYPTION_KEY=test-recipient-key-at-least-thirty-two-bytes\n";
    await chmod(path, 0o600);
    await writeFile(path, body + additions, { mode: 0o440 });
    await chmod(path, 0o440);
  }
}

async function installManagedPaymentFixture(directory) {
  const keyId = "payment-broker-testkey12345678";
  const managed = join(directory, "payment-managed");
  const versions = join(managed, "versions");
  const version = "payment-20260829T120000000Z-test12345678";
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const content = `PAYMENT_SECRET_CONFIGURATION_VERSION=${version}
UDUN_GATEWAY_BASE_URL=https://sig11.udun.io
UDUN_MERCHANT_ID=300015
UDUN_API_KEY=udun_managed_test_only_123456789
UDUN_CALLBACK_URL=https://main-test.agentnovas.com/api/integrations/payments/udun/webhook
UDUN_ADDRESS_REQUEST_COIN_FIELD=mainCoinType
`;
  const clientFile = `versions/${version}.client.env`;
  const maintenanceFile = `versions/${version}.maintenance.env`;
  await writeFile(join(managed, clientFile), content, { mode: 0o600 });
  await writeFile(join(managed, maintenanceFile), content, { mode: 0o600 });
  const digest = createHash("sha256").update(content).digest("hex");
  await writeFile(join(managed, "manifest.json"), `${JSON.stringify({
    schemaVersion: "1", version,
    client: { file: clientFile, sha256: digest }, maintenance: { file: maintenanceFile, sha256: digest },
  })}\n`, { mode: 0o600 });
  await writeFile(join(directory, "payment-secret-broker.env"), `NODE_ENV=production
DATABASE_URL=postgresql://agentnovas_payment_secret_broker:test-only@postgres:5432/agentnovas
PAYMENT_SECRET_BROKER_ENABLED=true
PAYMENT_SECRET_BROKER_KEY_ID=${keyId}
PAYMENT_SECRET_BROKER_PRIVATE_KEY_PATH=/run/secrets/payment-secret-broker-private.pem
PAYMENT_SECRET_DIRECTORY=/run/payment-secrets
PAYMENT_ALLOWED_CALLBACK_HOSTS=main-test.agentnovas.com,xm.agentnovas.com
`, { mode: 0o440 });
  await writeFile(join(directory, "payment-secret-broker-private.pem"), "test-only-private-key\n", { mode: 0o400 });
  await writeFile(join(directory, "payment-secret-broker-public.pem"), "test-only-public-key\n", { mode: 0o444 });
  for (const fileName of ["client.env", "maintenance.env"]) {
    const path = join(directory, fileName);
    const body = await readFile(path, "utf8");
    const additions = fileName === "maintenance.env"
      ? `PAYMENT_SECRET_BROKER_KEY_ID=${keyId}\nPAYMENT_SECRET_BROKER_PUBLIC_KEY_PATH=/run/secrets/payment-secret-broker-public.pem\nPAYMENT_SECRET_DIRECTORY=/run/payment-secrets\nPAYMENT_ALLOWED_CALLBACK_HOSTS=main-test.agentnovas.com,xm.agentnovas.com\n`
      : "PAYMENT_SECRET_DIRECTORY=/run/payment-secrets\n";
    await chmod(path, 0o600);
    await writeFile(path, body + additions, { mode: 0o440 });
    await chmod(path, 0o440);
  }
}

test("the production audit reports readiness facts without exposing configuration values", async () => {
  const directory = await fixtureDirectory();
  try {
    const result = await run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory });
    assert.match(result.stdout, /core_configuration=ready/);
    assert.match(result.stdout, /resend_configuration=incomplete/);
    assert.match(result.stdout, /email_secret_broker_configuration=incomplete/);
    assert.match(result.stdout, /payment_secret_broker_configuration=incomplete/);
    assert.match(result.stdout, /udun_configuration=incomplete/);
    assert.match(result.stdout, /payment_provider_outbound=disabled/);
    assert.match(result.stdout, /notification_email_send=disabled/);
    assert.match(result.stdout, /release_orchestrator_worker_staging=disabled/);
    assert.match(result.stdout, /release_orchestrator_worker_production=disabled/);
    assert.match(result.stdout, /release_provider_security_auditor_staging=disabled/);
    assert.match(result.stdout, /release_provider_security_auditor_production=disabled/);
    assert.match(result.stdout, /release_identity_verifier=disabled/);
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\/|shared-notification-key|shared-llm-key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production audit accepts a complete managed Resend secret configuration without exposing it", async () => {
  const directory = await fixtureDirectory();
  try {
    await installManagedEmailFixture(directory);
    const result = await run("scripts/audit-production-config.sh", [], {
      RIVERTON_SECRET_DIR: directory,
      RIVERTON_EMAIL_SECRET_DIR: join(directory, "email-managed"),
    });
    assert.match(result.stdout, /email_secret_broker_configuration=ready/);
    assert.match(result.stdout, /resend_configuration=ready/);
    assert.doesNotMatch(result.stdout + result.stderr, /re_managed|whsec_managed|test-only@postgres/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production audit accepts a complete managed Udun configuration without exposing it", async () => {
  const directory = await fixtureDirectory();
  try {
    await installManagedPaymentFixture(directory);
    const result = await run("scripts/audit-production-config.sh", [], {
      RIVERTON_SECRET_DIR: directory,
      RIVERTON_PAYMENT_SECRET_DIR: join(directory, "payment-managed"),
    });
    assert.match(result.stdout, /payment_secret_broker_configuration=ready/);
    assert.match(result.stdout, /udun_configuration=ready/);
    assert.doesNotMatch(result.stdout + result.stderr, /udun_managed|300015|test-only@postgres|sig11/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the production audit fails closed when a managed email secret file is tampered", async () => {
  const directory = await fixtureDirectory();
  try {
    await installManagedEmailFixture(directory);
    const manifest = JSON.parse(await readFile(join(directory, "email-managed", "manifest.json"), "utf8"));
    await writeFile(join(directory, "email-managed", manifest.notification.file), "tampered\n", { mode: 0o600 });
    await assert.rejects(
      run("scripts/audit-production-config.sh", [], {
        RIVERTON_SECRET_DIR: directory,
        RIVERTON_EMAIL_SECRET_DIR: join(directory, "email-managed"),
      }),
      (error) => error.stderr.includes("email-managed:manifest_or_secret_files_invalid"),
    );
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

test("restricted CI/CD Worker and Auditor enablement cannot diverge within an environment", async () => {
  const directory = await fixtureDirectory();
  try {
    await replaceEnvValue(
      directory,
      "release-orchestrator-staging.env",
      "RELEASE_ORCHESTRATOR_WORKER_ENABLED",
      "true",
    );
    await assert.rejects(
      run("scripts/audit-production-config.sh", [], { RIVERTON_SECRET_DIR: directory }),
      (error) => error.stderr.includes("restricted_cicd_staging:worker_auditor_enablement_mismatch"),
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

test("the fill-in installer preserves secret-file ownership while retaining restrictive modes", async (t) => {
  const currentGroup = process.getgid?.();
  const alternateGroup = process.getgroups?.().find((group) => group !== currentGroup);
  if (currentGroup === undefined || alternateGroup === undefined || process.getuid === undefined) {
    t.skip("requires a POSIX user that belongs to at least two groups");
    return;
  }

  const directory = await fixtureDirectory();
  const answerFile = join(directory, "resend-only.answers");
  const protectedFiles = ["client.env", "maintenance.env", "notification.env"];
  await writeFile(answerFile, `RESEND_API_KEY=re_test_only_rotated_key_123456789
RESEND_WEBHOOK_SECRET=whsec_test_only_webhook_secret_123456789
NOTIFICATION_EMAIL_ALLOWLIST=acceptance@example.test
`, { mode: 0o600 });
  await chmod(answerFile, 0o600);

  try {
    for (const fileName of protectedFiles) {
      await chown(join(directory, fileName), process.getuid(), alternateGroup);
    }
    const before = await Promise.all(protectedFiles.map((fileName) => stat(join(directory, fileName))));

    await run("scripts/install-production-integrations.sh", ["--apply", answerFile], { RIVERTON_SECRET_DIR: directory });

    const after = await Promise.all(protectedFiles.map((fileName) => stat(join(directory, fileName))));
    for (let index = 0; index < protectedFiles.length; index += 1) {
      assert.equal(after[index].uid, before[index].uid, `${protectedFiles[index]} owner changed`);
      assert.equal(after[index].gid, before[index].gid, `${protectedFiles[index]} group changed`);
      assert.equal(after[index].mode & 0o777, 0o440, `${protectedFiles[index]} mode changed`);
    }
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
