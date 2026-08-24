import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  recordFollowPaperOrderIntent,
  settlePendingFollowPaperOrder,
} from "../lib/follow-paper-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `follow_paper_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;
let cycleSeq = 0;

async function intent(action, overrides = {}) {
  cycleSeq += 1;
  const cycleId = `fp-cycle-${cycleSeq}`;
  await pool.query(`
    INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,status,candle_open_time,candle_close_time,started_at,fencing_token,decision_json,trace_id)
    VALUES ($1,'fp-deployment',$2,'completed',$3::timestamptz,$3::timestamptz + interval '1 hour',$3::timestamptz,1,'{}'::jsonb,$1)
  `, [cycleId, cycleSeq, new Date(Date.UTC(2026, 7, 24) + cycleSeq * 3_600_000).toISOString()]);
  return recordFollowPaperOrderIntent(pool, {
    deploymentId: "fp-deployment",
    portfolioId: "fp-portfolio",
    runtimeCycleId: cycleId,
    idempotencyKey: `fp-key-${cycleSeq}`,
    symbol: "ADAUSDT",
    action,
    timing: "next_candle_open",
    requestedPrice: null,
    shadow: false,
    payload: { quoteAmountUsdt: 300, feeRate: 0.001 },
    ...overrides,
  });
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-fp-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "follow-paper-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('fp-author','fp-author@quality.invalid','test-only-hash','customer','active'),
      ('fp-customer','fp-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('fp-strategy','fp-author','跟单策略','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id)
      VALUES ('fp-version','fp-strategy',1,'{}','fp-author');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,capital_pct)
      VALUES ('fp-subscription','fp-strategy','fp-customer','active','2026-08-01T00:00:00Z','fp-version','paper',5);
    INSERT INTO strategy_follow_paper_portfolios(id,subscription_id,customer_id,strategy_id)
      VALUES ('fp-portfolio','fp-subscription','fp-customer','fp-strategy');
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
      idempotency_key,execution_product,strategy_subscription_id,follow_paper_portfolio_id
    ) VALUES ('fp-deployment','fp-customer','fp-strategy','fp-version','paper','active','UNVERIFIED',
      'fp-deployment','spot_usdt','fp-subscription','fp-portfolio');
    INSERT INTO strategy_follow_contracts(
      id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
      strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256
    ) VALUES ('fp-contract','fp-subscription','fp-strategy','fp-customer','fp-author','fp-version',
      1,1800,5000,'marketplace','{"capitalPct":5,"stopLossPct":10}'::jsonb,repeat('a',64));
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("买入意图结算成持仓，现金按名义金额与手续费扣减", async () => {
  await intent("buy");
  const filled = await settlePendingFollowPaperOrder(pool, {
    deploymentId: "fp-deployment", fillPrice: 0.5,
    fillTime: new Date("2026-08-24T02:00:00Z"), timing: "next_candle_open", traceId: "fp-1",
  });
  assert.equal(filled.status, "filled");

  const position = await pool.query(
    "SELECT symbol,quantity,average_entry_price FROM strategy_follow_paper_positions WHERE portfolio_id='fp-portfolio' AND status='open'");
  assert.equal(position.rowCount, 1);
  assert.equal(position.rows[0].symbol, "ADAUSDT");
  assert.equal(Number(position.rows[0].average_entry_price), 0.5);

  const portfolio = await pool.query(
    "SELECT cash_usdt,fees_usdt FROM strategy_follow_paper_portfolios WHERE id='fp-portfolio'");
  assert.ok(Number(portfolio.rows[0].cash_usdt) < 10_000);
  assert.ok(Number(portfolio.rows[0].fees_usdt) > 0);
});

test("卖出结算出已实现盈亏，净盈亏小于毛盈亏", async () => {
  await intent("sell");
  const filled = await settlePendingFollowPaperOrder(pool, {
    deploymentId: "fp-deployment", fillPrice: 0.6,
    fillTime: new Date("2026-08-25T02:00:00Z"), timing: "next_candle_open", traceId: "fp-2",
  });
  assert.equal(filled.status, "filled");
  assert.ok(filled.realizedNetPnlUsdt > 0);

  const receipt = await pool.query(`
    SELECT realized_gross_pnl_usdt,realized_net_pnl_usdt FROM strategy_follow_paper_fill_receipts
     WHERE portfolio_id='fp-portfolio' AND action='sell'`);
  // 手续费是真实成本。记少了会让净利记多，进而分成多收（INV-5）。
  assert.ok(Number(receipt.rows[0].realized_net_pnl_usdt) < Number(receipt.rows[0].realized_gross_pnl_usdt));

  // 平仓后持仓关闭而不是删除——删掉等于抹掉这段历史，而周结算要按回执与持仓复核。
  const closed = await pool.query(
    "SELECT status,closed_at FROM strategy_follow_paper_positions WHERE portfolio_id='fp-portfolio'");
  assert.equal(closed.rows[0].status, "closed");
  assert.ok(closed.rows[0].closed_at);
});

test("同一决策轮重复入队落在同一行上", async () => {
  // 否则一次决策会记两笔成交，而模拟盘盈亏正是绩效分成的计算基础。
  cycleSeq += 1;
  await pool.query(`
    INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,status,candle_open_time,candle_close_time,started_at,fencing_token,decision_json,trace_id)
    VALUES ('fp-dup-cycle','fp-deployment',$1,'completed','2026-08-26T00:00:00Z','2026-08-26T01:00:00Z','2026-08-26T01:00:00Z',1,'{}'::jsonb,'fp-trace-dup')
  `, [cycleSeq]);
  const args = {
    deploymentId: "fp-deployment", portfolioId: "fp-portfolio", runtimeCycleId: "fp-dup-cycle",
    idempotencyKey: "fp-dup-key", symbol: "ADAUSDT", action: "buy",
    timing: "next_candle_open", requestedPrice: null, shadow: false,
    payload: { quoteAmountUsdt: 300, feeRate: 0.001 },
  };
  const first = await recordFollowPaperOrderIntent(pool, args);
  const second = await recordFollowPaperOrderIntent(pool, args);
  assert.equal(first.id, second.id);
});

test("记账拒绝时标 rejected 并记下原因，不静默跳过", async () => {
  // 一笔既没被执行也没被拒绝的意图会永远留在队列里，下一轮再被取出来。
  await settlePendingFollowPaperOrder(pool, {
    deploymentId: "fp-deployment", fillPrice: 0.5,
    fillTime: new Date("2026-08-26T02:00:00Z"), timing: "next_candle_open", traceId: "fp-3",
  });
  await intent("buy", { payload: { quoteAmountUsdt: 999_999, feeRate: 0.001 } });
  const rejected = await settlePendingFollowPaperOrder(pool, {
    deploymentId: "fp-deployment", fillPrice: 0.5,
    fillTime: new Date("2026-08-27T02:00:00Z"), timing: "next_candle_open", traceId: "fp-4",
  });
  assert.equal(rejected.status, "rejected");
  const row = await pool.query(
    "SELECT status,rejection_code FROM strategy_follow_paper_order_intents WHERE id=$1", [rejected.intentId]);
  assert.equal(row.rows[0].status, "rejected");
  assert.ok(row.rows[0].rejection_code, "被拒必须说明原因");
});

test("成交回执 append-only", async () => {
  // 回执是客户模拟盘盈亏的原始事实，也是周结算的输入。能改写它就能事后调整已实现盈亏。
  await assert.rejects(
    pool.query("UPDATE strategy_follow_paper_fill_receipts SET realized_net_pnl_usdt=999 WHERE portfolio_id='fp-portfolio'"),
    (error) => /FOLLOW_PAPER_RECEIPT_APPEND_ONLY/.test(error.message),
  );
  await assert.rejects(
    pool.query("DELETE FROM strategy_follow_paper_fill_receipts WHERE portfolio_id='fp-portfolio'"),
    (error) => /FOLLOW_PAPER_RECEIPT_APPEND_ONLY/.test(error.message),
  );
});

test("没有待结算意图时返回 null，不报错", async () => {
  const nothing = await settlePendingFollowPaperOrder(pool, {
    deploymentId: "fp-deployment", fillPrice: 0.5,
    fillTime: new Date("2026-08-28T02:00:00Z"), timing: "next_candle_open", traceId: "fp-5",
  });
  assert.equal(nothing, null);
});

test("同一组合同一品种只能有一个未平仓位", async () => {
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_follow_paper_positions(id,portfolio_id,symbol,status,quantity,average_entry_price,cost_basis_usdt)
      VALUES ('fp-dup-a','fp-portfolio','SOLUSDT','open',1,100,100),
             ('fp-dup-b','fp-portfolio','SOLUSDT','open',1,100,100)
    `),
    (error) => /uq_strategy_follow_paper_open_position|duplicate key/.test(error.message),
    "允许两个会让「这个策略现在持有多少」有两个答案",
  );
});
