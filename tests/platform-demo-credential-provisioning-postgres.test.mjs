import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { provisionPlatformDemoCredentials } from "../lib/platform-demo-credential-provisioning.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `demo_credentials_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
const encryptSecret = async (value) => `cipher:${createHash("sha256").update(value).digest("hex")}`;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, role text NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users(id,role,status) VALUES ('admin','hq_admin','active');
    CREATE TABLE audit_logs (
      id text PRIMARY KEY, actor_user_id text, action text NOT NULL,
      subject_type text NOT NULL, subject_id text NOT NULL,
      before_json text, after_json text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE strategy_versions (id text PRIMARY KEY, specification_json text NOT NULL);
    CREATE TABLE exchange_accounts (id text PRIMARY KEY, exchange text NOT NULL);
    CREATE TABLE memberships (
      id text PRIMARY KEY, customer_id text NOT NULL, status text NOT NULL,
      expires_at text, grace_ends_at text
    );
    CREATE TABLE strategy_subscriptions (id text PRIMARY KEY);
    CREATE TABLE platform_decisions (id text PRIMARY KEY);
    CREATE TABLE trades (id text PRIMARY KEY);
  `);
  for (const filename of ["0004_market_data_snapshots.sql", "0007_strategy_runtime.sql", "0024_platform_demo_execution.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("Demo credentials are encrypted, audited and initially fail-closed", async () => {
  const result = await provisionPlatformDemoCredentials(pool, {
    okx: { label: "OKX Demo", apiKey: "okx-api-key", secret: "okx-secret", passphrase: "okx-passphrase" },
    binance: { label: "Binance Spot Testnet", apiKey: "binance-api-key", secret: "binance-secret" },
    bybit: { label: "Bybit Demo", apiKey: "bybit-api-key", secret: "bybit-secret" },
  }, { encryptSecret });
  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, ["binance", "bybit", "okx"]);

  const accounts = (await pool.query(`
    SELECT provider,label,api_key_ciphertext,secret_ciphertext,passphrase_ciphertext,
           enabled,kill_switch_enabled,last_verified_at,last_verification_status
    FROM platform_demo_accounts ORDER BY provider
  `)).rows;
  assert.equal(accounts.length, 3);
  assert.ok(accounts.every((account) => account.enabled === false && account.kill_switch_enabled === true));
  assert.ok(accounts.every((account) => account.last_verified_at === null && account.last_verification_status === null));
  assert.ok(accounts.every((account) => account.api_key_ciphertext.startsWith("cipher:")));
  assert.ok(accounts.every((account) => account.secret_ciphertext.startsWith("cipher:")));
  assert.equal(accounts.find((account) => account.provider === "okx").passphrase_ciphertext.startsWith("cipher:"), true);
  assert.ok(accounts.filter((account) => account.provider !== "okx").every((account) => account.passphrase_ciphertext === null));

  const cards = (await pool.query(`
    SELECT provider,strategy_code,kill_switch_enabled
    FROM platform_demo_card_controls ORDER BY provider,strategy_code
  `)).rows;
  assert.equal(cards.length, 9);
  assert.ok(cards.every((card) => card.kill_switch_enabled === true));

  const serialized = JSON.stringify({ accounts, audits: (await pool.query(`
    SELECT before_json,after_json FROM audit_logs
    WHERE action='system.platform_demo_credentials_provisioned'
  `)).rows });
  for (const secret of ["okx-api-key", "okx-secret", "okx-passphrase", "binance-api-key", "binance-secret", "bybit-api-key", "bybit-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("credential rotation disables and kills an account and invalidates old verification", async () => {
  await pool.query(`
    UPDATE platform_demo_accounts
    SET enabled=true,kill_switch_enabled=false,last_verified_at=now(),last_verification_status='passed'
    WHERE provider='binance'
  `);
  await provisionPlatformDemoCredentials(pool, {
    binance: { label: "Binance Rotated", apiKey: "rotated-binance-key", secret: "rotated-binance-secret" },
  }, { encryptSecret });
  const account = (await pool.query(`
    SELECT label,enabled,kill_switch_enabled,last_verified_at,last_verification_status
    FROM platform_demo_accounts WHERE provider='binance'
  `)).rows[0];
  assert.deepEqual(account, {
    label: "Binance Rotated",
    enabled: false,
    kill_switch_enabled: true,
    last_verified_at: null,
    last_verification_status: null,
  });
});

test("provider input is strict and the CLI never accepts credential values in arguments", async () => {
  await assert.rejects(provisionPlatformDemoCredentials(pool, {
    okx: { label: "OKX", apiKey: "short", secret: "also-short" },
  }, { encryptSecret }), /PLATFORM_DEMO_OKX_PASSPHRASE_REQUIRED|PLATFORM_DEMO_CREDENTIAL_INVALID/);
  const source = await readFile(new URL("../scripts/provision-platform-demo-credentials.mjs", import.meta.url), "utf8");
  assert.match(source, /ALLOW_PLATFORM_DEMO_CREDENTIAL_PROVISIONING/);
  assert.match(source, /PLATFORM_DEMO_CREDENTIAL_INPUT/);
  assert.doesNotMatch(source, /process\.argv|stdout\.write\([^)]*(apiKey|secret|passphrase)/i);
  assert.match(source, /0o400|0o600/);
});
