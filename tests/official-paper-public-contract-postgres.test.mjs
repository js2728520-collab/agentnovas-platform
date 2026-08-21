import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { officialPaperPortfolioDto } from "../lib/official-paper-public-contract.ts";
import { listOfficialPaperPortfolios, listOfficialPaperTrades } from "../lib/official-paper-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `paper_dto_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE official_paper_portfolios (
      id text PRIMARY KEY, membership_id text NOT NULL, customer_id text NOT NULL,
      strategy_code text NOT NULL, principal_usdt numeric(30,12) NOT NULL,
      cash_usdt numeric(30,12) NOT NULL, realized_pnl_usdt numeric(30,12) NOT NULL,
      realized_gross_pnl_usdt numeric(30,12) NOT NULL,
      realized_net_pnl_usdt numeric(30,12) NOT NULL, fees_usdt numeric(30,12) NOT NULL,
      access_status text NOT NULL, updated_at timestamptz NOT NULL
    );
    CREATE TABLE official_paper_positions (
      id text PRIMARY KEY, portfolio_id text NOT NULL, symbol text NOT NULL, side text NOT NULL,
      status text NOT NULL, quantity numeric(30,12) NOT NULL,
      average_entry_price numeric(30,12) NOT NULL, cost_basis_usdt numeric(30,12) NOT NULL,
      entry_fees_usdt numeric(30,12) NOT NULL, last_mark_price numeric(30,12) NOT NULL,
      unrealized_pnl_usdt numeric(30,12) NOT NULL, opened_at timestamptz NOT NULL
    );
    CREATE TABLE strategy_deployments (
      id text PRIMARY KEY, owner_user_id text NOT NULL, paper_portfolio_id text,
      strategy_subscription_id text, platform_strategy_code text, execution_product text,
      mode text NOT NULL, status text NOT NULL, last_cycle_sequence bigint NOT NULL DEFAULT 0,
      last_candle_close_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    );
    CREATE TABLE official_paper_order_intents (
      id text PRIMARY KEY, runtime_cycle_id text NOT NULL
    );
    CREATE TABLE official_paper_fill_receipts (
      id text PRIMARY KEY, portfolio_id text NOT NULL, intent_id text NOT NULL,
      symbol text NOT NULL, action text NOT NULL, quantity numeric(30,12) NOT NULL,
      fill_price numeric(30,12) NOT NULL, notional_usdt numeric(30,12) NOT NULL,
      fee_usdt numeric(30,12) NOT NULL, allocated_entry_fee_usdt numeric(30,12) NOT NULL,
      realized_pnl_usdt numeric(30,12) NOT NULL, realized_gross_pnl_usdt numeric(30,12) NOT NULL,
      realized_net_pnl_usdt numeric(30,12) NOT NULL, trace_id text NOT NULL, filled_at timestamptz NOT NULL
    );
    INSERT INTO official_paper_portfolios VALUES (
      'official-paper:m1:ai_conservative','m1','customer-1','ai_conservative',
      10000,8000,0,0,0,0,'active','2026-08-20T00:00:00Z'
    );
    INSERT INTO official_paper_positions VALUES (
      'position-1','official-paper:m1:ai_conservative','BTCUSDT','long','open',
      0.123456789012,12345.678901234567,1524.157875319616,0.1,
      12345.678901234567,0,'2026-08-20T00:00:00Z'
    );
    INSERT INTO official_paper_portfolios VALUES (
      'official-paper:m1:ai_balanced','m1','customer-1','ai_balanced',
      10000,10000,0,0,0,0,'active','2026-08-20T00:00:00Z'
    );
    INSERT INTO strategy_deployments VALUES (
      'deployment-1','customer-1','official-paper:m1:ai_conservative','subscription-1',
      'ai_conservative','spot_usdt','paper','active',4,'2026-08-20T01:00:00Z',
      '2026-08-20T00:00:00Z','2026-08-20T01:00:00Z'
    );
    INSERT INTO official_paper_order_intents VALUES
      ('intent-1','cycle-1'),('intent-2','cycle-2');
    INSERT INTO official_paper_fill_receipts VALUES
      ('fill-1','official-paper:m1:ai_conservative','intent-1','BTCUSDT','buy',0.1,100,10,0.01,0,0,0,0,'trace-1','2026-08-20T02:00:00Z'),
      ('fill-2','official-paper:m1:ai_balanced','intent-2','ETHUSDT','buy',0.2,100,20,0.02,0,0,0,0,'trace-2','2026-08-20T01:00:00Z');
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("Postgres market value is quantized before the public decimal contract", async () => {
  const row = (await listOfficialPaperPortfolios(pool, "customer-1"))
    .find(({ strategyCode }) => strategyCode === "ai_conservative");
  assert.ok(row);
  const dto = officialPaperPortfolioDto(row);
  assert.equal(dto.marketValueUsdt, "1524.157875319616");
  assert.equal(dto.equityUsdt, "9524.157875319616");
  assert.deepEqual(dto.runtime, {
    state: "ACTIVE",
    deploymentId: "deployment-1",
    subscriptionId: "subscription-1",
    mode: "PAPER",
    lastCycleSequence: 4,
    lastDecisionAt: "2026-08-20T01:00:00.000Z",
  });
});

test("paper trade pagination scopes a portfolio on the server without leaking another card", async () => {
  const result = await listOfficialPaperTrades(pool, {
    customerId: "customer-1",
    portfolioId: "official-paper:m1:ai_conservative",
    limit: 10,
  });
  assert.deepEqual(result.items.map(({ id }) => id), ["fill-1"]);
  const hidden = await listOfficialPaperTrades(pool, {
    customerId: "another-customer",
    portfolioId: "official-paper:m1:ai_conservative",
    limit: 10,
  });
  assert.deepEqual(hidden.items, []);
});
