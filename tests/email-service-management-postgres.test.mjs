import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  listEmailTestHistory,
  loadEmailServiceOverview,
} from "../lib/email-service-management.ts";
import {
  createEmailTestRecipient,
  deleteEmailTestRecipient,
  listEmailTestRecipients,
  loadActiveEmailTestRecipient,
  updateEmailTestRecipient,
  verifyEmailTestRecipient,
} from "../lib/email-test-recipient-management.ts";
import { notificationDatabaseTestRecipientAllowed } from "../lib/notification-email-worker.ts";
import {
  claimEmailSecretRequest,
  completeEmailSecretRequest,
  createEmailSecretRequest,
  loadEmailSecretManagementStatus,
  recordEmailSecretBrokerHeartbeat,
} from "../lib/email-secret-management.ts";
import { decryptEmailSecretEnvelope } from "../lib/email-secret-broker.ts";
import { encryptEmailSecretPayload } from "../packages/ui/src/email-service-manager/browser-encryption.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `email_service_management_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const environment = {
  EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY: "postgres-test-recipient-key-with-more-than-32-characters",
};
const request = new Request("https://main-test.agentnovas.com/api/maintenance/email/recipients");
let brokerDirectory="";
let brokerKeyId="";
let brokerPrivateKey="";
let brokerPublicKey="";

async function transaction(command) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await command(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationOptions = {
    directory: new URL("../postgres/migrations/", import.meta.url),
    commitSha: "email-service-management-test",
  };
  const migrated = await runPostgresMigrations(pool, migrationOptions);
  assert.ok(migrated.applied.includes("0090_email_service_management.sql"));
  assert.ok(migrated.applied.includes("0091_email_service_management_v2.sql"));
  const rerun = await runPostgresMigrations(pool, migrationOptions);
  assert.deepEqual(rerun.applied, []);
  assert.ok(rerun.skipped.includes("0090_email_service_management.sql"));
  await pool.query(`
    INSERT INTO organizations(id,type,name,status) VALUES('hq','headquarters','HQ','active');
    INSERT INTO users(id,email,password_hash,role,organization_id,status,created_at,updated_at) VALUES
      ('admin','operator@example.com','unused','hq_admin','hq','active',now(),now()),
      ('other','another@example.com','unused','hq_admin','hq','active',now(),now());
  `);
  await pool.query(`UPDATE notification_provider_configs SET status='active',settings_json=$1::jsonb
      WHERE provider='resend' AND channel='email'`, [JSON.stringify({
    senderDomainVerified: true,
    webhookVerified: true,
    templatesVerified: true,
    suppressionEnabled: true,
  })]);
  await pool.query(`
    INSERT INTO worker_instances(worker_type,instance_id,status,heartbeat_at,metadata_json)
      VALUES('notification','worker-1','running',now(),$1::jsonb)
  `, [JSON.stringify({
    apiKeyPresent: true,
    allowlistConfigured: true,
    emailEnvironmentReady: true,
  })]);
  brokerDirectory=await mkdtemp(join(tmpdir(),"email-secret-management-postgres-"));
  const pair=generateKeyPairSync("rsa",{
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki",format: "pem" },
    privateKeyEncoding: { type: "pkcs8",format: "pem" },
  });
  brokerKeyId="email-broker-postgres-test";
  brokerPrivateKey=pair.privateKey;
  brokerPublicKey=pair.publicKey;
  await writeFile(join(brokerDirectory,"public.pem"),brokerPublicKey,{ mode: 0o444 });
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(brokerDirectory,{ recursive: true,force: true });
});

let recipientId = "";

test("Maintenance creates an encrypted independent recipient and verifies ownership", async () => {
  const created = await transaction(client => createEmailTestRecipient(client, {
    actorUserId: "admin",
    email: "independent.qa@example.net",
    label: "外部验收邮箱",
    reason: "新增独立测试收件地址",
    request,
    idempotencyHash: "a".repeat(64),
    environment,
    now: new Date("2026-08-29T00:00:00.000Z"),
    verificationCodeFactory: () => "042019",
  }));
  recipientId = created.recipient.id;
  assert.equal(created.recipient.status, "pending_verification");
  assert.equal(created.recipient.address, "independent.qa@example.net");
  const row = (await pool.query(`SELECT recipient_hash,recipient_ciphertext,recipient_mask,status,
      verification_code_hash FROM notification_email_test_recipients WHERE id=$1`, [recipientId])).rows[0];
  assert.match(row.recipient_hash, /^[a-f0-9]{64}$/);
  assert.equal(row.status, "pending_verification");
  assert.match(row.verification_code_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(row), /independent\.qa@example\.net|042019/);
  assert.equal(await notificationDatabaseTestRecipientAllowed(pool, "independent.qa@example.net"), false);

  await transaction(client => verifyEmailTestRecipient(client, {
    actorUserId: "admin",recipientId,code: "042019",reason: "验证收件邮箱所有权",request,
    environment,now: new Date("2026-08-29T00:01:00.000Z"),
  }));
  assert.equal(await notificationDatabaseTestRecipientAllowed(pool, "independent.qa@example.net"), true);
  const active = await loadActiveEmailTestRecipient(pool,recipientId,environment);
  assert.equal(active.address, "independent.qa@example.net");
  const recipients = await listEmailTestRecipients(pool,environment);
  assert.deepEqual(recipients.map(item => [item.label,item.status,item.address]), [
    ["外部验收邮箱","active","independent.qa@example.net"],
  ]);
});

test("history exposes the viewer recipient and masks other operators", async () => {
  await pool.query(`
    INSERT INTO notification_deliveries(
      id,user_id,test_recipient_id,channel,category,template_key,payload_json,status,scheduled_at,
      sent_at,provider_message_id,provider_event_type,provider_event_at,last_error,dedupe_key,created_at
    ) VALUES
      ('delivery-other','other',NULL,'email','api_security','maintenance_email_test','{}','delivered',$1::text,$2::text,'provider-message-other','email.delivered',$2::timestamptz,NULL,'other-test',$1::text),
      ('delivery-admin','admin',$3,'email','api_security','maintenance_email_test','{}','failed',$2::text,NULL,NULL,NULL,NULL,'RECIPIENT_NOT_ALLOWLISTED','admin-test',$2::text)
  `, ["2026-08-29T00:00:00.000Z", "2026-08-29T00:01:00.000Z",recipientId]);
  const history = await listEmailTestHistory(pool, { viewerUserId: "admin", limit: "20",environment });
  assert.equal(history.tests[0].recipient, "independent.qa@example.net");
  assert.equal(history.tests[0].lastErrorCode, "RECIPIENT_NOT_ALLOWLISTED");
  assert.equal(history.tests[1].recipient, "a•••••r@example.com");
  assert.equal(history.tests[1].recipientVisibility, "masked");
  assert.equal(history.tests[1].providerMessageReference, "provid…ther");
});

test("overview becomes degraded after the newest failed test instead of reporting ready", async () => {
  const overview = await loadEmailServiceOverview(pool, {
    viewerUserId: "admin",
    viewerEmail: "operator@example.com",
    includeTestRecipient: true,
    webhookSecretPresent: true,
  });
  assert.equal(overview.configured, true);
  assert.equal(overview.effectiveStatus, "degraded");
  assert.equal(overview.lastTestStatus, "failed");
  assert.equal(JSON.stringify(overview).includes("RESEND_API_KEY"), false);
});

test("write-only secret request is encrypted at rest, leased to the broker and projected without ciphertext",async()=>{
  const brokerEnvironment={
    EMAIL_SECRET_BROKER_KEY_ID: brokerKeyId,
    EMAIL_SECRET_BROKER_PUBLIC_KEY_PATH: join(brokerDirectory,"public.pem"),
  };
  const envelope=await encryptEmailSecretPayload({
    keyId: brokerKeyId,publicKeyPem: brokerPublicKey,
    resendApiKey: "re_postgres_secret_material_123456",
    resendWebhookSecret: "whsec_postgres_secret_material_123456",
  });
  const created=await transaction(client=>createEmailSecretRequest(client,{
    actorUserId: "admin",operation: "install",envelope,
    reason: "安装测试环境 Resend 密钥",request,environment: brokerEnvironment,
  }));
  assert.equal(created.request.status,"pending");
  assert.doesNotMatch(JSON.stringify(created),/re_postgres|whsec_postgres|wrappedKey|ciphertext/);
  const durable=(await pool.query(`SELECT envelope_json,status FROM notification_email_secret_requests WHERE id=$1`,[created.request.id])).rows[0];
  assert.equal(durable.status,"pending");
  assert.doesNotMatch(JSON.stringify(durable),/re_postgres|whsec_postgres/);

  await recordEmailSecretBrokerHeartbeat(pool,{
    instanceId: "broker-postgres-test",status: "running",now: new Date("2026-08-29T00:03:00.000Z"),
  });
  const status=await loadEmailSecretManagementStatus(pool,brokerEnvironment,new Date("2026-08-29T00:03:01.000Z"));
  assert.equal(status.browserConfigurable,true);
  assert.equal(status.latestRequest.id,created.request.id);
  assert.equal(status.latestRequest.requestedBy,"o••••••r@example.com");
  assert.doesNotMatch(JSON.stringify(status),/re_postgres|whsec_postgres|wrappedKey|ciphertext/);

  const claimed=await claimEmailSecretRequest(pool,{
    workerId: "broker-postgres-test",now: new Date("2026-08-29T00:03:02.000Z"),
  });
  assert.equal(claimed.id,created.request.id);
  assert.deepEqual(await decryptEmailSecretEnvelope(claimed.envelope,{
    keyId: brokerKeyId,privateKeyPem: brokerPrivateKey,
  }),{
    resendApiKey: "re_postgres_secret_material_123456",
    resendWebhookSecret: "whsec_postgres_secret_material_123456",
  });
  assert.equal(await completeEmailSecretRequest(pool,{
    requestId: claimed.id,workerId: "broker-postgres-test",version: "email-20260829T000302000Z-abcdef123456",
    fingerprint: "0123456789abcdef",now: new Date("2026-08-29T00:03:03.000Z"),
  }),true);
  const completed=await loadEmailSecretManagementStatus(pool,brokerEnvironment,new Date("2026-08-29T00:03:04.000Z"));
  assert.equal(completed.latestRequest.status,"applied");
  assert.equal(completed.latestRequest.configurationFingerprint,"0123456789abcdef");
  assert.equal(await claimEmailSecretRequest(pool,{ workerId: "broker-postgres-test",now: new Date("2026-08-29T00:03:05.000Z") }),null);
});

test("disabling and deleting the independent recipient fail closed without changing Provider authorization", async () => {
  const disabled = await transaction(client => updateEmailTestRecipient(client, {
    actorUserId: "admin",recipientId,action: "disable",reason: "暂停验收地址",request,environment,
    now: new Date("2026-08-29T00:02:00.000Z"),
  }));
  assert.equal(disabled.recipient.status, "disabled");
  assert.equal(await notificationDatabaseTestRecipientAllowed(pool, "independent.qa@example.net"), false);
  assert.equal((await pool.query(`SELECT status FROM notification_provider_configs WHERE id='resend-email'`)).rows[0].status, "active");
  await transaction(client => deleteEmailTestRecipient(client, {
    actorUserId: "admin",recipientId,reason: "删除不再使用的验收地址",request,
  }));
  assert.equal((await listEmailTestRecipients(pool,environment)).length, 0);
  const tombstone = (await pool.query(`SELECT status,recipient_ciphertext,recipient_mask FROM notification_email_test_recipients WHERE id=$1`,[recipientId])).rows[0];
  assert.equal(tombstone.status,"deleted");
  assert.equal(tombstone.recipient_ciphertext,null);
  assert.equal(tombstone.recipient_mask,"i••••••a@example.net");
});
