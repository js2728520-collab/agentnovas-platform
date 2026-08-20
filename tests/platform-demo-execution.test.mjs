import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { PlatformDemoResponseError } from "../lib/platform-demo-adapters.ts";
import {
  createPlatformDemoIntent,
  leaseNextPlatformDemoIntent,
  processNextPlatformDemoExecution,
  renewPlatformDemoLease,
} from "../lib/platform-demo-execution.ts";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `platform_demo_test_${process.pid}_${Date.now()}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

function intentInput(overrides = {}) {
  return {
    provider: "binance",
    strategyCode: "ai_balanced",
    decisionRoundId: "round-a",
    runtimeCycleId: "cycle-a",
    traceId: "trace-a",
    symbol: "BTCUSDT",
    side: "buy",
    referencePrice: 10_000,
    ...overrides,
  };
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE strategy_versions (id text PRIMARY KEY, specification_json text NOT NULL);
    CREATE TABLE exchange_accounts (id text PRIMARY KEY, exchange text NOT NULL);
    CREATE TABLE memberships (id text PRIMARY KEY, status text NOT NULL, expires_at text, grace_ends_at text);
    CREATE TABLE strategy_subscriptions (id text PRIMARY KEY);
    CREATE TABLE platform_decisions (id text PRIMARY KEY);
    CREATE TABLE trades (id text PRIMARY KEY);
  `);
  for (const filename of ["0004_market_data_snapshots.sql", "0007_strategy_runtime.sql", "0024_platform_demo_execution.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE platform_demo_accounts, platform_demo_card_controls CASCADE");
  for (const provider of ["okx", "binance", "bybit"]) {
    await pool.query(`
      INSERT INTO platform_demo_accounts (
        id, provider, label, api_key_ciphertext, secret_ciphertext,
        passphrase_ciphertext, enabled
      ) VALUES ($1, $2, $3, 'fixture-key', 'fixture-secret', $4, true)
    `, [`account-${provider}`, provider, `${provider} fixture`, provider === "okx" ? "fixture-passphrase" : null]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("demo intents are provider/card/round idempotent with deterministic IDs and a fixed 10 USDT notional", async () => {
  const first = await createPlatformDemoIntent(pool, intentInput());
  const repeated = await createPlatformDemoIntent(pool, intentInput());
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.clientOrderId, first.clientOrderId);
  assert.equal(repeated.quoteAmountUsdt, 10);
  await assert.rejects(createPlatformDemoIntent(pool, intentInput({ symbol: "ETHUSDT" })), /幂等|不同/);
  const row = (await pool.query("SELECT quote_amount_usdt, client_order_id FROM platform_demo_order_intents")).rows[0];
  assert.equal(Number(row.quote_amount_usdt), 10);
  assert.equal(row.client_order_id, first.clientOrderId);
});

test("provider and card kill switches plus the 100 USDT provider daily cap are enforced before execution", async () => {
  await pool.query("UPDATE platform_demo_accounts SET kill_switch_enabled = true WHERE provider = 'binance'");
  await assert.rejects(createPlatformDemoIntent(pool, intentInput()), /kill switch|停控/i);
  await pool.query("UPDATE platform_demo_accounts SET kill_switch_enabled = false WHERE provider = 'binance'");
  await pool.query("INSERT INTO platform_demo_card_controls (provider, strategy_code, kill_switch_enabled) VALUES ('binance', 'ai_balanced', true)");
  await assert.rejects(createPlatformDemoIntent(pool, intentInput()), /kill switch|停控/i);
  await pool.query("DELETE FROM platform_demo_card_controls");

  for (let index = 0; index < 10; index += 1) {
    await createPlatformDemoIntent(pool, intentInput({ decisionRoundId: `cap-round-${index}`, runtimeCycleId: `cap-cycle-${index}` }));
  }
  const repeatedAtCap = await createPlatformDemoIntent(pool, intentInput({
    decisionRoundId: "cap-round-9",
    runtimeCycleId: "cap-cycle-9",
  }));
  assert.equal(repeatedAtCap.decisionRoundId, "cap-round-9");
  await assert.rejects(
    createPlatformDemoIntent(pool, intentInput({ decisionRoundId: "cap-round-11", runtimeCycleId: "cap-cycle-11" })),
    /daily cap|100 USDT/i,
  );
});

test("demo queue leases use fencing and heartbeat renewal", async () => {
  const intent = await createPlatformDemoIntent(pool, intentInput());
  const now = new Date(Date.now() + 60_000);
  const lease = await leaseNextPlatformDemoIntent(pool, { workerId: "demo-worker-a", now, leaseSeconds: 30 });
  assert.equal(lease.id, intent.id);
  assert.equal(lease.fencingToken, 1);
  assert.equal(await leaseNextPlatformDemoIntent(pool, { workerId: "demo-worker-b", now: new Date(now.getTime() + 10_000), leaseSeconds: 30 }), null);
  const renewed = await renewPlatformDemoLease(pool, {
    intentId: intent.id, workerId: "demo-worker-a", fencingToken: 1,
    now: new Date(now.getTime() + 20_000), leaseSeconds: 30,
  });
  assert.equal(renewed.leaseExpiresAt.getTime(), now.getTime() + 50_000);
  const recovered = await leaseNextPlatformDemoIntent(pool, {
    workerId: "demo-worker-b", now: new Date(now.getTime() + 51_000), leaseSeconds: 30,
  });
  assert.equal(recovered.fencingToken, 2);
  assert.equal(recovered.leasedFromStatus, "unknown");
});

test("timeout lookup avoids duplicate placement and provider failure cannot roll back customer paper", async () => {
  await pool.query(`
    INSERT INTO official_paper_portfolios (
      id, membership_id, customer_id, strategy_code, risk_json
    ) VALUES ('paper-a', 'membership-a', 'customer-a', 'ai_balanced', '{}')
  `);
  await createPlatformDemoIntent(pool, intentInput());
  let placeCalls = 0;
  let lookupCalls = 0;
  const adapter = {
    async placeOrder() {
      placeCalls += 1;
      throw new PlatformDemoResponseError("fixture timeout", { unknownExecutionState: true });
    },
    async getOrder(input) {
      lookupCalls += 1;
      if (lookupCalls === 1) throw new Error("fixture lookup temporarily unavailable");
      return { provider: "binance", providerOrderId: "provider-order-a", clientOrderId: input.clientOrderId, status: "open", filledBaseQuantity: 0 };
    },
    async listFills() { return []; },
  };
  const firstNow = new Date(Date.now() + 1_000);
  const uncertain = await processNextPlatformDemoExecution(pool, { workerId: "demo-worker" }, {
    externalWritesEnabled: true,
    createAdapter: () => adapter,
    decryptSecret: async (value) => value,
    now: () => firstNow,
  });
  assert.equal(uncertain.status, "unknown");
  assert.equal(placeCalls, 1);
  const result = await processNextPlatformDemoExecution(pool, { workerId: "demo-worker" }, {
    externalWritesEnabled: true, createAdapter: () => adapter, decryptSecret: async (value) => value,
    now: () => new Date(firstNow.getTime() + 20_000),
  });
  assert.equal(result.status, "recorded");
  assert.equal(result.executionStatus, "accepted");
  assert.equal(placeCalls, 1);
  assert.equal(lookupCalls, 2);
  const portfolio = (await pool.query("SELECT principal_usdt, cash_usdt FROM official_paper_portfolios WHERE id = 'paper-a'")).rows[0];
  assert.equal(Number(portfolio.principal_usdt), 10_000);
  assert.equal(Number(portfolio.cash_usdt), 10_000);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_demo_execution_receipts")).rows[0].count, 1);
  await assert.rejects(
    pool.query("UPDATE platform_demo_execution_receipts SET safe_summary_json = '{}'::jsonb"),
    /append-only/i,
  );

  await createPlatformDemoIntent(pool, intentInput({
    provider: "bybit",
    decisionRoundId: "round-provider-failure",
    runtimeCycleId: "cycle-provider-failure",
    traceId: "trace-provider-failure",
  }));
  const failed = await processNextPlatformDemoExecution(pool, { workerId: "demo-worker-failure" }, {
    externalWritesEnabled: true,
    createAdapter: () => ({
      async placeOrder() { throw new Error("fixture provider rejected request"); },
      async getOrder() { throw new Error("must not query a known rejection"); },
      async listFills() { return []; },
    }),
    decryptSecret: async (value) => value,
    now: () => new Date(Date.now() + 1_000),
  });
  assert.equal(failed.status, "retry_wait");
  const unchanged = (await pool.query("SELECT principal_usdt, cash_usdt FROM official_paper_portfolios WHERE id = 'paper-a'")).rows[0];
  assert.equal(Number(unchanged.principal_usdt), 10_000);
  assert.equal(Number(unchanged.cash_usdt), 10_000);
});

test("external write feature flag defaults false without leasing the queue", async () => {
  await createPlatformDemoIntent(pool, intentInput());
  const result = await processNextPlatformDemoExecution(pool, { workerId: "demo-worker" }, {
    createAdapter: () => { throw new Error("adapter must not be created"); },
    decryptSecret: async (value) => value,
  });
  assert.deepEqual(result, { status: "disabled" });
  assert.equal((await pool.query("SELECT status FROM platform_demo_order_intents")).rows[0].status, "pending");
  const safeColumns = (await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'platform_demo_accounts_safe'
  `)).rows.map((row) => row.column_name);
  assert.equal(safeColumns.some((name) => name.includes("ciphertext")), false);
  assert.ok(safeColumns.includes("has_secret"));
});
