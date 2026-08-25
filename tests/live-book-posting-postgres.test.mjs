import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import pg from "pg";

import { postLiveFillsToBook } from "../lib/live-book-posting.ts";
import { withGlobalRoleLock } from "./helpers/postgres-global-roles.mjs";

// 实盘成交落账。LIVE_EXECUTION_BLOCKERS 前三条的验证点：
// 仓位、风控读数、绩效分成三者都读账本，这条路不通它们同时是错的，且都不报错。
//
// 用整条迁移链建库——这个模块横跨 official_paper_*、live_execution_receipts、
// execution_reconciliations、strategy_deployments 四组表，手搓子集会漏掉正是要验的约束。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const dbName = `live_book_${process.pid}_${Date.now()}`;
let pool;

async function migrate() {
  const { execFileSync } = await import("node:child_process");
  // 这条链跑在本文件自建的数据库里，而 PostgreSQL advisory lock 是按数据库隔离的——
  // 迁移器在那个库里拿到的锁，看不见其他测试文件在协调库里做的角色 DDL。角色却是
  // 集群全局的：0043/0072 仍会 REVOKE 一个被并行文件中途删掉的角色。所以显式在协调库
  // 上取同一把锁。
  const coordinator = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await withGlobalRoleLock(coordinator, () => {
      execFileSync(process.execPath, ["--experimental-strip-types", "scripts/apply-postgres-migrations.mjs"], {
        env: { ...process.env, DATABASE_URL: new URL(`/${dbName}`, databaseUrl.replace(/\/[^/]*$/, "/")).toString() },
        stdio: "pipe",
      });
    });
  } finally {
    await coordinator.end();
  }
}

before(async () => {
  assert.match(dbName, /^[a-z0-9_]+$/);
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  await migrate();
  pool = new pg.Pool({ connectionString: databaseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
});

after(async () => {
  await pool?.end();
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
});

const PRINCIPAL = 3_000;

beforeEach(async () => {
  // 0075/0089 deliberately reject truncating current work records. Test cleanup
  // models the controlled retention job first, then uses TRUNCATE for unrelated
  // fixture tables.
  await pool.query(`
    UPDATE strategy_runtime_events SET created_at=now() - interval '7 months';
    UPDATE strategy_runtime_cycles SET completed_at=now() - interval '7 months';
    UPDATE official_paper_order_intents SET created_at=now() - interval '7 months';
    UPDATE strategy_subscription_periods SET created_at=now() - interval '7 months';
    UPDATE strategy_decision_rounds SET created_at=now() - interval '7 months';
    UPDATE strategy_deployments SET created_at=now() - interval '7 months';
  `);
  // Permanent evidence is intentionally not truncatable in production. This
  // privileged fixture reset disables user triggers only while rebuilding an
  // isolated test fixture; the tests below verify the production triggers with
  // normal session settings.
  await pool.query(`
    ALTER TABLE official_paper_fill_receipts DISABLE TRIGGER USER;
    ALTER TABLE official_paper_ledger_entries DISABLE TRIGGER USER;
    ALTER TABLE live_execution_receipts DISABLE TRIGGER USER;
    ALTER TABLE live_book_postings DISABLE TRIGGER USER;
    ALTER TABLE strategy_follow_paper_fill_receipts DISABLE TRIGGER USER;
    TRUNCATE live_book_postings, live_execution_receipts, execution_reconciliations,
      official_paper_ledger_entries, official_paper_fill_receipts,
      official_paper_order_intents, official_paper_positions,
      strategy_deployments, official_paper_portfolios, strategy_runtime_cycles,
      strategy_versions, community_strategies, memberships, exchange_accounts, users CASCADE;
    ALTER TABLE official_paper_fill_receipts ENABLE TRIGGER USER;
    ALTER TABLE official_paper_ledger_entries ENABLE TRIGGER USER;
    ALTER TABLE live_execution_receipts ENABLE TRIGGER USER;
    ALTER TABLE live_book_postings ENABLE TRIGGER USER;
    ALTER TABLE strategy_follow_paper_fill_receipts ENABLE TRIGGER USER
  `);
  await pool.query(`INSERT INTO users (id,email,password_hash,role,status)
    VALUES ('cust-1','live@example.com','x','customer','active')`);
  await pool.query(`INSERT INTO memberships (id,customer_id,plan_code,status)
    VALUES ('m1','cust-1','beta','active')`);
  await pool.query(`INSERT INTO exchange_accounts
    (id,customer_id,exchange,label,environment,encrypted_credential_ref,status)
    VALUES ('acct-1','cust-1','binance','probe','live','ref-1','active')`);
  await pool.query(`INSERT INTO official_paper_portfolios
    (id,membership_id,customer_id,strategy_code,book,principal_usdt,cash_usdt,risk_json,exchange_account_id)
    VALUES ('pf-live','m1','cust-1','ai_balanced','live',$1,$1,'{}'::jsonb,'acct-1')`, [PRINCIPAL]);
  await pool.query(`INSERT INTO community_strategies (id,author_user_id,name) VALUES ('s1','cust-1','probe')`);
  await pool.query(`INSERT INTO strategy_versions (id,strategy_id,version,specification_json,created_by_user_id) VALUES ('sv1','s1',1,'{}','cust-1')`);
  await pool.query(`INSERT INTO strategy_deployments
    (id,owner_user_id,strategy_id,strategy_version_id,mode,validation_label,idempotency_key,
     execution_product,paper_portfolio_id,membership_id,platform_strategy_code,exchange_account_id)
    VALUES ('d-live','cust-1','s1','sv1','live','STANDARD_VERIFIED','k1','spot_usdt',
            'pf-live','m1','ai_balanced','acct-1')`);
  await pool.query(`INSERT INTO strategy_runtime_cycles
    (id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at)
    VALUES ('cycle-1','d-live',1,0,'2026-08-23T09:00:00Z','2026-08-23T10:00:00Z','completed','{}'::jsonb,'t1',now()),
           ('cycle-2','d-live',2,0,'2026-08-23T10:00:00Z','2026-08-23T11:00:00Z','completed','{}'::jsonb,'t2',now())`);
});

async function receipt(over = {}) {
  const row = {
    id: `r-${over.intent_id ?? "i1"}`, intent_id: "i1", side: "buy", outcome: "filled",
    filled_quantity: 0.01, average_price: 60_000, fee_amount: 0.6,
    executed_at: "2026-08-23T10:00:00Z", runtime_cycle_id: "cycle-1", ...over,
  };
  await pool.query(`
    INSERT INTO live_execution_receipts
      (id,deployment_id,customer_id,exchange_account_id,decision_round_id,runtime_cycle_id,
       intent_id,symbol,side,outcome,filled_quantity,average_price,fee_amount,rejection_reason,executed_at)
    VALUES ($1,'d-live','cust-1','acct-1',$2,$2,$3,'BTCUSDT',$4,$5,$6,$7,$8,$9,$10)
  `, [row.id, row.runtime_cycle_id, row.intent_id, row.side, row.outcome,
      row.filled_quantity, row.average_price, row.fee_amount, row.rejection_reason ?? null, row.executed_at]);
  return row;
}

async function portfolio() {
  return (await pool.query("SELECT * FROM official_paper_portfolios WHERE id='pf-live'")).rows[0];
}

test("买入成交落账：仓位建起来，现金按真实成交额扣", async () => {
  // 阻塞点 1。此前实盘成交不写任何仓位表，position 恒为 null，
  // 于是引擎只会不断产出开仓意图，永远不产出平仓意图——客户无法通过平台离场。
  await receipt();
  const results = await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "posted");

  const position = (await pool.query("SELECT * FROM official_paper_positions WHERE portfolio_id='pf-live'")).rows[0];
  assert.ok(position, "没有仓位记录 = 引擎永远看不到自己持仓");
  assert.equal(Number(position.quantity), 0.01);
  assert.equal(Number(position.average_entry_price), 60_000);
  assert.equal(position.status, "open");

  const book = await portfolio();
  // 3000 - 600(名义) - 0.6(手续费)
  assert.equal(Number(book.cash_usdt), 2_399.4);
  assert.equal(Number(book.fees_usdt), 0.6, "手续费按交易所回报的金额记，不按费率反推");
});

test("手续费按金额记账，不经过费率往返", async () => {
  // 反推费率再乘回去要先除后乘，在 8 位小数上会漂，而漂掉的正是客户实际付出的成本。
  await receipt({ intent_id: "i-fee", fee_amount: 0.123456789, filled_quantity: 0.01, average_price: 60_000 });
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  const fill = (await pool.query("SELECT fee_usdt FROM official_paper_fill_receipts")).rows[0];
  assert.equal(Number(fill.fee_usdt), 0.12345679, "8 位小数内如实保留");
});

test("风控读数从实盘净值算出来，不再恒为 0", async () => {
  // 阻塞点 2。此前回撤与日亏取自模拟盘净值，实盘成交不进那张表，
  // 于是 drawdownPct 与 dailyLossPct 恒为 0，客户自己的风控预算被静默旁路。
  await receipt();
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  const risk = (await pool.query("SELECT risk_state_json FROM strategy_deployments WHERE id='d-live'")).rows[0].risk_state_json;
  assert.ok(Number.isFinite(Number(risk.equityUsdt)), "风控读数必须有净值");
  // 买入当下净值 = 现金 + 仓位成本 = 3000 - 0.6（只少了手续费）
  assert.ok(Math.abs(Number(risk.equityUsdt) - (PRINCIPAL - 0.6)) < 1e-6, `净值应约为 ${PRINCIPAL - 0.6}`);
  assert.ok(Number(risk.drawdownPct) > 0, "手续费已经让净值低于本金，回撤不该是 0");
});

test("百分比风控按客户真实本金算", async () => {
  // 回撤的基准是这个组合自己的本金（首个峰值取本金）。本金写死 10000 而客户实际
  // 只投了 3000 时，基准比真实资金高一倍多，算出来的回撤与客户的实际处境无关
  // ——数字照样在动，只是量错了对象。
  await receipt({ intent_id: "i-dd", filled_quantity: 0.01, average_price: 60_000, fee_amount: 300 });
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  const risk = (await pool.query("SELECT risk_state_json FROM strategy_deployments WHERE id='d-live'")).rows[0].risk_state_json;
  // 净值 2700，本金 3000 → 回撤 10%；若按 10000 算只有 3%
  assert.ok(Math.abs(Number(risk.drawdownPct) - 10) < 0.01, `回撤应为 10%，实际 ${risk.drawdownPct}`);
});

test("卖出平仓：仓位关闭，已实现盈亏进账本", async () => {
  await receipt();
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  await receipt({ intent_id: "i2", side: "sell", filled_quantity: 0.01, average_price: 65_000,
    fee_amount: 0.65, runtime_cycle_id: "cycle-2", executed_at: "2026-08-23T11:00:00Z" });
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });

  const position = (await pool.query("SELECT status FROM official_paper_positions WHERE portfolio_id='pf-live'")).rows[0];
  assert.equal(position.status, "closed");
  const book = await portfolio();
  // 毛利 (65000-60000)*0.01 = 50；净利再扣两侧手续费 0.6 + 0.65
  assert.ok(Math.abs(Number(book.realized_gross_pnl_usdt) - 50) < 1e-6);
  assert.ok(Math.abs(Number(book.realized_net_pnl_usdt) - (50 - 1.25)) < 1e-6, "净利必须扣掉两侧手续费");
});

test("绩效分成读得到实盘成交", async () => {
  // 阻塞点 3。此前 live_execution_receipts 零读取方，实盘盈亏既不进仓位也不进分成。
  await receipt();
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  await receipt({ intent_id: "i2", side: "sell", filled_quantity: 0.01, average_price: 65_000,
    fee_amount: 0.65, runtime_cycle_id: "cycle-2", executed_at: "2026-08-23T11:00:00Z" });
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });

  // 分成的取数口径：按组合聚合 action='sell' 的成交回执。
  const { rows } = await pool.query(`
    SELECT sum(realized_net_pnl_usdt) AS net FROM official_paper_fill_receipts
    WHERE portfolio_id = 'pf-live' AND action = 'sell'`);
  assert.ok(Math.abs(Number(rows[0].net) - 48.75) < 1e-6, "分成依据必须是实盘净利");
});

test("重复记账被挡住——重放同一轮决策会凭空复制客户的仓位", async () => {
  await receipt();
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  const again = await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  assert.deepEqual(again, [], "第二次不该再记");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM official_paper_fill_receipts");
  assert.equal(rows[0].n, 1);
  const book = await portfolio();
  assert.equal(Number(book.cash_usdt), 2_399.4, "现金不该被扣两次");
});

test("对账未决时停下，不跳过去记后面那笔", async () => {
  // 跳过会让账本按错误顺序累计：一笔未决的买入后面跟着一笔卖出，
  // 先记卖出等于卖掉一个账上还不存在的仓位。
  await receipt();
  await pool.query(`INSERT INTO execution_reconciliations
    (id,client_order_id,account_id,customer_id,exchange,symbol,requested_quantity,intent_id,status)
    VALUES ('rec-1','co-1','acct-1','cust-1','binance','BTCUSDT',0.01,'i1','pending')`);
  await receipt({ intent_id: "i2", side: "sell", filled_quantity: 0.01, average_price: 65_000,
    fee_amount: 0.65, runtime_cycle_id: "cycle-2", executed_at: "2026-08-23T11:00:00Z" });

  const results = await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  assert.deepEqual(results, [], "队首未决就整条停住");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM official_paper_fill_receipts");
  assert.equal(rows[0].n, 0);
});

test("对账推翻回执时按对账的事实记账，并留下标记", async () => {
  // 回执说被拒（客户以为没成交），对账查实成交了。不修正的话客户手里有币而平台
  // 认为没有——引擎永远不会产出平仓意图。
  await receipt({ intent_id: "i-flip", outcome: "rejected", filled_quantity: 0,
    average_price: 0, fee_amount: 0, rejection_reason: "TIMEOUT" });
  await pool.query(`INSERT INTO execution_reconciliations
    (id,client_order_id,account_id,customer_id,exchange,symbol,requested_quantity,intent_id,
     status,resolved_outcome,filled_quantity,average_price,fee_amount,resolved_at)
    VALUES ('rec-2','co-2','acct-1','cust-1','binance','BTCUSDT',0.01,'i-flip',
            'resolved','filled',0.01,60000,0.6,'2026-08-23T10:05:00Z')`);

  const results = await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  assert.equal(results[0].status, "posted");
  const position = (await pool.query("SELECT quantity FROM official_paper_positions WHERE portfolio_id='pf-live'")).rows[0];
  assert.equal(Number(position.quantity), 0.01, "仓位必须建起来，否则客户拿着币而平台不知道");

  const posting = (await pool.query("SELECT fact_source, contradicts_receipt FROM live_book_postings")).rows[0];
  assert.equal(posting.fact_source, "reconciliation");
  assert.equal(posting.contradicts_receipt, true, "执行链路出问题的信号，运营要能捞出来");
});

test("被拒的意图登记为已处理，但不产生账本回执", async () => {
  await receipt({ intent_id: "i-rej", outcome: "rejected", filled_quantity: 0,
    average_price: 0, fee_amount: 0, rejection_reason: "INSUFFICIENT_BALANCE" });
  const results = await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  assert.equal(results[0].status, "skipped");
  const posting = (await pool.query("SELECT outcome, fill_receipt_id FROM live_book_postings")).rows[0];
  assert.equal(posting.outcome, "rejected");
  assert.equal(posting.fill_receipt_id, null);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM official_paper_fill_receipts");
  assert.equal(rows[0].n, 0);
});

test("账本记录不可改写", async () => {
  await receipt();
  await postLiveFillsToBook(pool, { deploymentId: "d-live" });
  await assert.rejects(() => pool.query("UPDATE live_book_postings SET outcome='rejected'"), /append-only/);
  await assert.rejects(() => pool.query("DELETE FROM live_book_postings"), /append-only/);
});

test("模拟盘部署不会被这条路记账", async () => {
  // 走错账本会把模拟决策记进实盘账，或反过来。
  const results = await postLiveFillsToBook(pool, { deploymentId: "does-not-exist" });
  assert.deepEqual(results, []);
});
