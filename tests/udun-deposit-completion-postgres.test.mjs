import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  claimPaymentSecretRequest, completePaymentSecretRequest, createPaymentSecretRequest,
  loadPaymentSecretManagementStatus, recordPaymentSecretBrokerHeartbeat,
} from "../lib/payment-secret-management.ts";
import { listPaymentProviderTestRuns, recordPaymentProviderTestRun } from "../lib/payment-provider-test-management.ts";
import { encryptPaymentSecretPayload } from "../packages/ui/src/payment-service-manager/browser-encryption.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `udun_completion_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const request = new Request("https://main-test.agentnovas.com/api/maintenance/payment-secrets/requests");
let directory = "";
let publicKeyPem = "";

async function transaction(command) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await command(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const options = { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "udun-completion-test" };
  const migrated = await runPostgresMigrations(pool, options);
  assert.ok(migrated.applied.includes("0092_udun_deposit_service_completion.sql"));
  const rerun = await runPostgresMigrations(pool, options);
  assert.deepEqual(rerun.applied, []);
  await pool.query(`
    INSERT INTO organizations(id,type,name,status) VALUES('hq','headquarters','HQ','active');
    INSERT INTO users(id,email,password_hash,role,organization_id,status,created_at,updated_at)
      VALUES('admin','operator@example.com','unused','hq_admin','hq','active',now(),now()),
            ('customer','customer@example.com','unused','customer','hq','active',now(),now());
  `);
  directory = await mkdtemp(join(tmpdir(), "payment-secret-postgres-"));
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  publicKeyPem = pair.publicKey;
  await writeFile(join(directory, "public.pem"), publicKeyPem, { mode: 0o444 });
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
  await rm(directory, { recursive: true, force: true });
});

test("database reserves only one open Udun address intent per customer and network", async () => {
  const insert = (id, status) => pool.query(`INSERT INTO deposit_orders(
    id,platform_order_no,user_id,currency,network,expected_amount,channel,provider,provider_config_id,order_status
  ) VALUES($1,$2,'customer','USDT','TRC20',1,'on_chain','udun','udun-usdt-trc20',$3)`, [id, `DEP-${id}`, status]);
  await insert("order-a", "ADDRESS_PROVISIONING");
  await assert.rejects(insert("order-b", "ADDRESS_PROVISIONING"), error => error?.code === "23505");
  await pool.query("UPDATE deposit_orders SET order_status='ADDRESS_FAILED' WHERE id='order-a'");
  await insert("order-b", "ADDRESS_PROVISIONING");
  await pool.query("UPDATE deposit_orders SET order_status='ADDRESS_UNKNOWN' WHERE id='order-b'");
  await assert.rejects(insert("order-c", "PENDING_CONFIRMATION"), error => error?.code === "23505");
});

test("ciphertext request is leased to the independent broker and applying a version invalidates old tests", async () => {
  const keyId = "payment-broker-postgres-test";
  const environment = {
    PAYMENT_SECRET_BROKER_KEY_ID: keyId,
    PAYMENT_SECRET_BROKER_PUBLIC_KEY_PATH: join(directory, "public.pem"),
  };
  const envelope = await encryptPaymentSecretPayload({
    keyId, publicKeyPem,
    configuration: {
      provider: "udun", gatewayBaseUrl: "https://sig11.udun.io", merchantId: "300015",
      apiKey: "udun_postgres_secret_material_123456",
      callbackUrl: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
      addressRequestCoinField: "mainCoinType",
    },
  });
  const created = await transaction(client => createPaymentSecretRequest(client, {
    actorUserId: "admin", operation: "install", envelope,
    reason: "安装优盾测试商户配置", request, environment,
  }));
  assert.equal(created.request.status, "pending");
  assert.doesNotMatch(JSON.stringify(created), /udun_postgres|300015|ciphertext|wrappedKey/);
  const stored = (await pool.query("SELECT envelope_json FROM payment_secret_requests WHERE id=$1", [created.request.id])).rows[0];
  assert.doesNotMatch(JSON.stringify(stored), /udun_postgres|300015/);

  await recordPaymentSecretBrokerHeartbeat(pool, {
    instanceId: "payment-broker-postgres", status: "running", now: new Date("2026-08-29T04:00:00.000Z"),
  });
  const status = await loadPaymentSecretManagementStatus(pool, environment, new Date("2026-08-29T04:00:01.000Z"));
  assert.equal(status.browserConfigurable, true);
  assert.equal(status.latestRequest.id, created.request.id);
  assert.doesNotMatch(JSON.stringify(status), /ciphertext|wrappedKey|udun_postgres/);

  const claimed = await claimPaymentSecretRequest(pool, {
    workerId: "payment-broker-postgres", now: new Date("2026-08-29T04:00:02.000Z"),
  });
  assert.equal(claimed.id, created.request.id);
  await pool.query(`UPDATE payment_provider_configs SET last_test_at=now(),last_test_status='passed',
    last_callback_test_at=now(),last_callback_test_status='passed' WHERE id='udun-usdt-trc20'`);
  assert.equal(await completePaymentSecretRequest(pool, {
    requestId: claimed.id, workerId: "payment-broker-postgres",
    version: "payment-20260829T040002000Z-abcdef123456", fingerprint: "0123456789abcdef",
    now: new Date("2026-08-29T04:00:03.000Z"),
  }), true);
  const provider = (await pool.query(`SELECT secret_configuration_version,last_test_status,
    last_callback_test_status FROM payment_provider_configs WHERE id='udun-usdt-trc20'`)).rows[0];
  assert.equal(provider.secret_configuration_version, "payment-20260829T040002000Z-abcdef123456");
  assert.equal(provider.last_test_status, null);
  assert.equal(provider.last_callback_test_status, null);
});

test("provider and callback test history is append-only, bounded, and safe to project", async () => {
  const completed = new Date("2026-08-29T05:00:01.000Z");
  const recorded = await recordPaymentProviderTestRun(pool, {
    providerConfigId: "udun-usdt-trc20", kind: "provider_connectivity", status: "failed",
    configurationVersion: "payment-test-history-v1", errorCode: "UDUN_HTTP_ERROR:503",
    actorUserId: "admin", reason: "验证测试记录可追溯且不会泄露商户密钥",
    requestId: "payment-test-request", traceId: "payment-test-trace",
    startedAt: new Date("2026-08-29T05:00:00.000Z"), completedAt: completed,
  });
  assert.equal(recorded.actor, "o•••@example.com");
  assert.equal(recorded.errorCode, "UDUN_HTTP_ERROR:503");
  assert.equal(recorded.configurationVersion, "payment-test-history-v1");
  const history = await listPaymentProviderTestRuns(pool, 10);
  assert.equal(history[0].id, recorded.id);
  assert.equal(history[0].completedAt, completed.toISOString());
  assert.doesNotMatch(JSON.stringify(history), /apiKey|merchantId|gatewayBaseUrl|wrappedKey|ciphertext/);
  await assert.rejects(pool.query(`UPDATE payment_provider_test_runs SET reason='changed' WHERE id=$1`, [recorded.id]),
    error => error?.code === "55000");
});
