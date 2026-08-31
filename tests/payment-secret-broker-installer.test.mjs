import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../scripts/install-payment-secret-broker.sh", import.meta.url).pathname;

function envValue(contents, key) {
  const values = contents.split(/\r?\n/).filter(line => line.startsWith(`${key}=`));
  assert.equal(values.length, 1, `${key} must occur exactly once`);
  return values[0].slice(key.length + 1);
}

test("payment broker bootstrap is repeatable, stays disabled and never prints secrets", async context => {
  if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) {
    context.skip("host-only installer requires openssl");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-payment-broker-install-"));
  try {
    const secretDirectory = join(directory, "secrets");
    const managedDirectory = join(directory, "managed");
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(join(secretDirectory, "client.env"), "NODE_ENV=production\n", { mode: 0o440 });
    await writeFile(join(secretDirectory, "maintenance.env"), "NODE_ENV=production\n", { mode: 0o440 });
    const answer = join(directory, "broker.answers");
    const databaseUrl = "postgresql://agentnovas_payment_secret_broker:never-print-this@postgres:5432/agentnovas";
    await writeFile(answer, `PAYMENT_SECRET_BROKER_DATABASE_URL=${databaseUrl}\nPAYMENT_ALLOWED_CALLBACK_HOSTS=main-test.agentnovas.com,xm.agentnovas.com\n`, { mode: 0o600 });
    await chmod(answer, 0o600);
    const environment = {
      ...process.env, RIVERTON_SECRET_DIR: secretDirectory, RIVERTON_PAYMENT_SECRET_DIR: managedDirectory,
      RIVERTON_SERVICE_UID: String(process.getuid?.() ?? 1000), RIVERTON_SERVICE_GID: String(process.getgid?.() ?? 1000),
    };
    const checked = await execute("bash", [script, "--check", answer], { env: environment });
    assert.match(checked.stdout, /configuration_update=not_applied/);
    assert.doesNotMatch(checked.stdout + checked.stderr, /never-print-this/);

    for (let pass = 0; pass < 2; pass += 1) {
      const applied = await execute("bash", [script, "--apply", answer], { env: environment });
      assert.match(applied.stdout, /provider_secrets=unchanged/);
      assert.match(applied.stdout, /provider_tests=disabled/);
      assert.match(applied.stdout, /provider_outbound=disabled/);
      assert.doesNotMatch(applied.stdout + applied.stderr, /never-print-this/);
    }
    const client = await readFile(join(secretDirectory, "client.env"), "utf8");
    const maintenance = await readFile(join(secretDirectory, "maintenance.env"), "utf8");
    assert.equal(envValue(client, "PAYMENT_PROVIDER_OUTBOUND_ENABLED"), "false");
    assert.equal(envValue(maintenance, "PAYMENT_PROVIDER_TESTS_ENABLED"), "false");
    assert.equal(envValue(maintenance, "PAYMENT_PROVIDER_OUTBOUND_ENABLED"), "false");
    assert.equal(envValue(maintenance, "PAYMENT_ALLOWED_CALLBACK_HOSTS"), "main-test.agentnovas.com,xm.agentnovas.com");
    assert.match(envValue(maintenance, "PAYMENT_SECRET_BROKER_KEY_ID"), /^payment-broker-/);
    assert.ok([0o400, 0o440].includes((await stat(join(secretDirectory, "payment-secret-broker-private.pem"))).mode & 0o777));
    assert.equal((await stat(join(secretDirectory, "payment-secret-broker.env"))).mode & 0o777, 0o440);

    await writeFile(answer, `PAYMENT_SECRET_BROKER_DATABASE_URL=${databaseUrl}\nPAYMENT_ALLOWED_CALLBACK_HOSTS=evil.example\n`, { mode: 0o600 });
    await assert.rejects(execute("bash", [script, "--check", answer], { env: environment }),
      error => error.stderr.includes("outside the controlled AgentNovas domain"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
