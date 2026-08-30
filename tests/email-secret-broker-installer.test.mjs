import assert from "node:assert/strict";
import { execFile,spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute=promisify(execFile);
const script=new URL("../scripts/install-email-secret-broker.sh",import.meta.url).pathname;

function envValue(contents,key) {
  const values=contents.split(/\r?\n/).filter(line=>line.startsWith(`${key}=`));
  assert.equal(values.length,1,`${key} must occur exactly once`);
  return values[0].slice(key.length+1);
}

test("broker bootstrap is repeatable, preserves recipient encryption and never prints secrets",async context=>{
  if (spawnSync("openssl",["version"],{ stdio: "ignore" }).status!==0) {
    context.skip("host-only installer requires openssl");
    return;
  }
  const directory=await mkdtemp(join(tmpdir(),"agentnovas-email-broker-install-"));
  try {
    const secretDirectory=join(directory,"secrets");
    const managedDirectory=join(directory,"managed");
    await mkdir(secretDirectory,{ recursive: true });
    await writeFile(join(secretDirectory,"maintenance.env"),"NODE_ENV=production\n",{ mode: 0o440 });
    await writeFile(join(secretDirectory,"notification.env"),"NODE_ENV=production\n",{ mode: 0o440 });
    const answer=join(directory,"broker.answers");
    const databaseUrl="postgresql://agentnovas_email_secret_broker:never-print-this@postgres:5432/agentnovas";
    await writeFile(answer,`EMAIL_SECRET_BROKER_DATABASE_URL=${databaseUrl}\n`,{ mode: 0o600 });
    await chmod(answer,0o600);
    const environment={
      ...process.env,
      RIVERTON_SECRET_DIR: secretDirectory,
      RIVERTON_EMAIL_SECRET_DIR: managedDirectory,
      RIVERTON_SERVICE_UID: String(process.getuid?.() ?? 1000),
      RIVERTON_SERVICE_GID: String(process.getgid?.() ?? 1000),
    };
    const checked=await execute("bash",[script,"--check",answer],{ env: environment });
    assert.match(checked.stdout,/configuration_update=not_applied/);
    assert.doesNotMatch(checked.stdout+checked.stderr,/never-print-this/);

    const first=await execute("bash",[script,"--apply",answer],{ env: environment });
    assert.match(first.stdout,/provider_secrets=unchanged/);
    assert.doesNotMatch(first.stdout+first.stderr,/never-print-this/);
    const maintenanceFirst=await readFile(join(secretDirectory,"maintenance.env"),"utf8");
    const notificationFirst=await readFile(join(secretDirectory,"notification.env"),"utf8");
    const recipientKey=envValue(maintenanceFirst,"EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY");
    assert.ok(recipientKey.length>=32);
    assert.equal(envValue(notificationFirst,"EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY"),recipientKey);
    assert.ok([0o400,0o440].includes((await stat(join(secretDirectory,"email-secret-broker-private.pem"))).mode & 0o777));
    assert.equal((await stat(join(secretDirectory,"email-secret-broker.env"))).mode & 0o777,0o440);

    const second=await execute("bash",[script,"--apply",answer],{ env: environment });
    assert.doesNotMatch(second.stdout+second.stderr,/never-print-this/);
    const maintenanceSecond=await readFile(join(secretDirectory,"maintenance.env"),"utf8");
    const notificationSecond=await readFile(join(secretDirectory,"notification.env"),"utf8");
    assert.equal(envValue(maintenanceSecond,"EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY"),recipientKey);
    assert.equal(envValue(notificationSecond,"EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY"),recipientKey);
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});
