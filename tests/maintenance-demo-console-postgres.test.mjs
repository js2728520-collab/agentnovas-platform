import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { loadMaintenanceDemoSafeView } from "../lib/maintenance-demo-view.ts";
import {
  claimPlatformDemoAdminCommand,
  completePlatformDemoAdminCommand,
  completedPlatformDemoCommandResponse,
} from "../lib/platform-demo-admin-commands.ts";

const { Pool } = pg;
const databaseUrl =
  process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `maintenance_demo_console_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema}`,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY);
    INSERT INTO users VALUES ('fixture-actor'),('reviewer');
    CREATE TABLE strategy_versions (id text PRIMARY KEY, specification_json text NOT NULL);
    CREATE TABLE exchange_accounts (id text PRIMARY KEY, exchange text NOT NULL);
    CREATE TABLE memberships (id text PRIMARY KEY, customer_id text NOT NULL, status text NOT NULL, expires_at text, grace_ends_at text);
    CREATE TABLE strategy_subscriptions (id text PRIMARY KEY);
    CREATE TABLE platform_decisions (id text PRIMARY KEY);
    CREATE TABLE trades (id text PRIMARY KEY);
    CREATE TABLE audit_logs (
      id text PRIMARY KEY, actor_user_id text, action text NOT NULL,
      subject_type text NOT NULL, subject_id text NOT NULL, created_at timestamptz DEFAULT now()
    );
  `);
  for (const filename of [
    "0004_market_data_snapshots.sql",
    "0007_strategy_runtime.sql",
    "0024_platform_demo_execution.sql",
    "0027_platform_demo_admin_commands.sql",
    "0035_technical_audit_correlation.sql",
  ]) {
    await pool.query(
      await readFile(
        new URL(`../postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  }
});

test.beforeEach(async () => {
  await pool.query(
    "TRUNCATE platform_demo_accounts,platform_demo_card_controls,platform_demo_control_audit,platform_demo_admin_commands CASCADE",
  );
  await pool.query(`
    INSERT INTO platform_demo_accounts (
      id,provider,label,api_key_ciphertext,secret_ciphertext,
      passphrase_ciphertext,enabled,last_verified_at,last_verification_status
    ) VALUES (
      'account-binance','binance','Binance fixture','fixture-api-key',
      'fixture-secret',NULL,true,now(),'passed'
    )
  `);
  await pool.query(`
    INSERT INTO platform_demo_card_controls (
      provider,strategy_code,kill_switch_enabled,updated_by
    ) VALUES ('binance','ai_aggressive',true,'fixture-actor')
  `);
  await pool.query(`
    INSERT INTO platform_demo_order_intents (
      id,account_id,provider,strategy_code,decision_round_id,runtime_cycle_id,
      trace_id,client_order_id,symbol,side,quote_amount_usdt,reference_price,status
    ) VALUES (
      'intent-1','account-binance','binance','ai_balanced','round-1','cycle-1',
      'trace-1','demo-client-00000001','BTCUSDT','buy',10,50000,'filled'
    )
  `);
  await pool.query(`
    INSERT INTO platform_demo_execution_receipts (
      id,intent_id,provider,provider_order_id,client_order_id,status,
      filled_base_quantity,filled_quote_usdt,fee_usdt,observed_at,trace_id
    ) VALUES (
      'receipt-1','intent-1','binance','provider-order-fixture',
      'demo-client-00000001','filled',0.0002,10,0.01,now(),'trace-1'
    )
  `);
});

test("Demo admin commands bind actor, reason and payload to an immutable idempotency key", async () => {
  const input = {
    operation: "control",
    idempotencyKey: "demo-control-key-0001",
    actorUserId: "reviewer",
    accountId: "account-binance",
    action: "kill",
    strategyCode: null,
    reason: "incident containment fixture",
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await claimPlatformDemoAdminCommand(client, input);
    assert.equal(claim.isNew, true);
    await completePlatformDemoAdminCommand(client, {
      id: claim.id,
      status: "succeeded",
      response: { ok: true, result: "CONTROL_RECORDED" },
    });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const replayClient = await pool.connect();
  try {
    await replayClient.query("BEGIN");
    const replay = await claimPlatformDemoAdminCommand(replayClient, input);
    assert.deepEqual(completedPlatformDemoCommandResponse(replay), {
      ok: true,
      result: "CONTROL_RECORDED",
    });
    await replayClient.query("COMMIT");
  } finally {
    replayClient.release();
  }
  const row = (
    await pool.query(
      "SELECT reason,status FROM platform_demo_admin_commands WHERE operation='control' AND idempotency_key=$1",
      [input.idempotencyKey],
    )
  ).rows[0];
  assert.deepEqual(row, {
    reason: "incident containment fixture",
    status: "succeeded",
  });
  const collisionClient = await pool.connect();
  try {
    await collisionClient.query("BEGIN");
    await assert.rejects(
      claimPlatformDemoAdminCommand(collisionClient, {
        ...input,
        reason: "different incident reason",
      }),
      (error) => error.code === "IDEMPOTENCY_KEY_COLLISION",
    );
    await collisionClient.query("ROLLBACK");
  } finally {
    collisionClient.release();
  }
  await assert.rejects(
    pool.query(
      "UPDATE platform_demo_admin_commands SET reason='tampered reason' WHERE idempotency_key=$1",
      [input.idempotencyKey],
    ),
    /immutable/i,
  );
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("maintenance Demo safe view exposes only boolean credential state and receipt summaries", async () => {
  const [account] = await loadMaintenanceDemoSafeView(pool);
  assert.equal(account.provider, "binance");
  assert.equal(account.hasApiKey, true);
  assert.equal(account.hasSecret, true);
  assert.equal(account.verificationFresh, true);
  assert.equal(account.dailyNotional, "10.000000000000");
  assert.equal(account.latestReceipt?.status, "filled");
  assert.equal(account.cards.length, 3);
  assert.equal(
    account.cards.find((card) => card.strategyCode === "ai_aggressive")
      ?.killSwitchEnabled,
    true,
  );
  const serialized = JSON.stringify(account);
  assert.doesNotMatch(serialized, /fixture-api-key|fixture-secret|provider-order-fixture/);
  assert.doesNotMatch(serialized, /ciphertext|passphraseCiphertext|providerOrderId/);
});

test("safe account rows can be locked and no-op controls do not duplicate audit", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`
      SELECT id,provider,enabled,kill_switch_enabled,has_api_key,has_secret
      FROM platform_demo_accounts_safe
      WHERE id='account-binance'
      FOR UPDATE
    `);
    assert.equal(locked.rowCount, 1);
    await client.query(`
      UPDATE platform_demo_accounts
      SET enabled=false,kill_switch_enabled=true,updated_by='reviewer',updated_at=now()
      WHERE id='account-binance'
        AND (enabled IS DISTINCT FROM false OR kill_switch_enabled IS DISTINCT FROM true)
    `);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const before = await pool.query(`
    SELECT count(*)::int AS count FROM platform_demo_control_audit
    WHERE scope='provider' AND provider='binance'
  `);
  const replay = await pool.query(`
    UPDATE platform_demo_accounts
    SET enabled=false,kill_switch_enabled=true,updated_by='reviewer',updated_at=now()
    WHERE id='account-binance'
      AND (enabled IS DISTINCT FROM false OR kill_switch_enabled IS DISTINCT FROM true)
  `);
  const after = await pool.query(`
    SELECT count(*)::int AS count FROM platform_demo_control_audit
    WHERE scope='provider' AND provider='binance'
  `);
  assert.equal(replay.rowCount, 0);
  assert.equal(after.rows[0].count, before.rows[0].count);
});
