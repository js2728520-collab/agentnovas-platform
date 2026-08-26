import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { processNextFollowRuntimeDeployment } from "../lib/follow-runtime-worker.ts";
import { completeFollowRuntimeCycle, settlePendingFollowPaperOrder } from "../lib/follow-paper-repository.ts";
import { loadFollowWeekRealizedPnl, settleFollowWeekFromBook } from "../lib/strategy-follow-settlement-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `follow_e2e_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

const HOUR = 3_600_000;
const START = Date.UTC(2026, 7, 1);

/** 一路上涨的 K 线：足以让 price_ema/ema_alignment 触发多头开仓。 */
function risingCandles(count = 40) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 2;
    return {
      openTime: START + index * HOUR,
      closeTime: START + (index + 1) * HOUR - 1,
      open, high: open + 2, low: open - 0.5, close: open + 1.5, volume: 1_000,
    };
  });
}

const dsl = {
  schemaVersion: 3, name: "跟单多头", market: "usdt_perpetual", marginMode: "isolated",
  leverage: 1, symbol: "BTCUSDT", timeframe: "1h", direction: "long_only",
  legs: {
    long: {
      entry: { all: [{ type: "price_ema", period: 10, operator: "above" }] },
      exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
      stopLossPct: 2, takeProfitPct: 4,
    },
  },
  risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
};

const deps = (rows) => ({
  now: () => new Date(rows.at(-1).closeTime + 1_000),
  getCandles: async () => ({ items: rows, provider: "fixture" }),
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-e2e-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`), commitSha: "follow-e2e",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('e2e-author','e2e-author@quality.invalid','test-only-hash','customer','active'),
      ('e2e-customer','e2e-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('e2e-strategy','e2e-author','跟单多头','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,capital_pct)
      VALUES ('e2e-sub','e2e-strategy','e2e-customer','active','2026-08-01T00:00:00Z','e2e-version','paper',5);
    INSERT INTO strategy_follow_paper_portfolios(id,subscription_id,customer_id,strategy_id)
      VALUES ('e2e-portfolio','e2e-sub','e2e-customer','e2e-strategy');
    INSERT INTO strategy_follow_contracts(
      id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
      strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256
    ) VALUES ('e2e-contract','e2e-sub','e2e-strategy','e2e-customer','e2e-author','e2e-version',
      1,1800,5000,'marketplace','{"capitalPct":5,"stopLossPct":10}'::jsonb,repeat('a',64));
  `, []);
  await pool.query(
    `INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id)
     VALUES ('e2e-version','e2e-strategy',1,$1,'e2e-author')`, [JSON.stringify(dsl)]);
  await pool.query(`
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
      idempotency_key,execution_product,strategy_subscription_id,follow_paper_portfolio_id,next_cycle_at
    ) VALUES ('e2e-deployment','e2e-customer','e2e-strategy','e2e-version','paper','active','UNVERIFIED',
      'e2e-deployment','spot_usdt','e2e-sub','e2e-portfolio','2026-07-31T00:00:00Z')
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("一轮完整周期：租约 → 决策 → 落库 → 意图入队", async () => {
  const rows = risingCandles();
  const result = await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-worker" }, deps(rows));
  assert.ok(result, "应当租到部署并跑完一轮");
  assert.equal(result.status, "completed");

  const cycle = await pool.query(
    "SELECT id,status,decision_json FROM strategy_runtime_cycles WHERE deployment_id='e2e-deployment'");
  assert.equal(cycle.rowCount, 1);
  assert.equal(cycle.rows[0].status, "completed");

  // 七阶段事件必须齐全（INV-8）。
  const events = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_runtime_events WHERE cycle_id=$1", [cycle.rows[0].id]);
  assert.equal(events.rows[0].count, 7);

  // 社区跟单不写共享决策轮——ADR-0018 的共享轮只属于三张官方卡。
  const rounds = await pool.query("SELECT count(*)::int AS count FROM strategy_decision_rounds");
  assert.equal(rounds.rows[0].count, 0);
});

test("同一根 K 线重跑不重复落库", async () => {
  // 两道防线。第一道在周期开始处：last_candle_close_at 已覆盖这根 K 线就直接等待，
  // 连行情都不再评估。
  await pool.query("UPDATE strategy_deployments SET next_cycle_at = '2026-07-31T00:00:00Z', lease_expires_at = NULL WHERE id='e2e-deployment'");
  const again = await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-worker-2" }, deps(risingCandles()));
  assert.equal(again.status, "waiting_for_candle");

  // 第二道在落库处：直接调用完成函数也必须幂等。第一道靠 last_candle_close_at，
  // 而那是可以被别的写入路径改掉的；两道都要在，否则一次决策会记两笔成交。
  const existing = await pool.query(
    "SELECT id,candle_open_time,candle_close_time,fencing_token FROM strategy_runtime_cycles WHERE deployment_id='e2e-deployment'");
  const row = existing.rows[0];
  const replay = await completeFollowRuntimeCycle(pool, {
    cycleId: "e2e-replay-cycle", deploymentId: "e2e-deployment", portfolioId: "e2e-portfolio",
    fencingToken: Number(row.fencing_token),
    candleOpenTime: row.candle_open_time, candleCloseTime: row.candle_close_time,
    decision: { action: "hold" }, orderIntent: null,
    events: Array.from({ length: 7 }, (_, index) => ({
      sequence: index + 1, role: `role-${index}`, conclusion: "x", evidence: {}, durationMs: 0, llmUsed: false,
    })),
    traceId: "e2e-replay", startedAt: new Date(), nextCycleAt: new Date(),
    symbol: "BTCUSDT", shadow: false, quoteAmountUsdt: 500, feeRate: 0.001,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, row.id, "重放必须返回原周期，不是新建的那个 id");

  const cycles = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_runtime_cycles WHERE deployment_id='e2e-deployment'");
  assert.equal(cycles.rows[0].count, 1);
});

test("入队的意图能结算成真实持仓与盈亏", async () => {
  const intents = await pool.query(
    "SELECT id,action,status,payload_json FROM strategy_follow_paper_order_intents WHERE deployment_id='e2e-deployment'");
  if (intents.rowCount === 0) {
    // 这批 K 线没有触发开仓也是合法结果；此时不该有任何成交。
    const receipts = await pool.query("SELECT count(*)::int AS count FROM strategy_follow_paper_fill_receipts");
    assert.equal(receipts.rows[0].count, 0);
    return;
  }
  assert.equal(intents.rows[0].action, "buy");
  // 单笔名义金额 = 本金 10,000 × 客户同意的每单占比 5% = 500。
  assert.equal(Number(intents.rows[0].payload_json.quoteAmountUsdt), 500);

  const settled = await settlePendingFollowPaperOrder(pool, {
    deploymentId: "e2e-deployment", fillPrice: 180,
    fillTime: new Date(START + 41 * HOUR), timing: "next_candle_open", traceId: "e2e-fill",
  });
  assert.equal(settled.status, "filled");
  const portfolio = await pool.query(
    "SELECT cash_usdt FROM strategy_follow_paper_portfolios WHERE id='e2e-portfolio'");
  assert.ok(Number(portfolio.rows[0].cash_usdt) < 10_000, "买入后现金应当减少");
});

test("终止的跟随不再被租走", async () => {
  await pool.query(`
    UPDATE strategy_subscriptions SET status='stopped', ended_by='customer', ended_reason='customer_stopped'
     WHERE id='e2e-sub'
  `);
  await pool.query("UPDATE strategy_deployments SET next_cycle_at = '2026-07-31T00:00:00Z', lease_expires_at = NULL WHERE id='e2e-deployment'");
  const none = await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-worker-3" }, deps(risingCandles()));
  assert.equal(none, null);
});

test("暂停的跟随仍然被租走——离场不能被挡住", async () => {
  // INV-7：退出能力不依赖跟随处于活跃状态。
  await pool.query(`
    UPDATE strategy_subscriptions SET status='risk_blocked', paused_by='automated_risk', paused_at=now(),
           ended_by=NULL, ended_reason=NULL WHERE id='e2e-sub'
  `);
  await pool.query("UPDATE strategy_deployments SET next_cycle_at = '2026-07-31T00:00:00Z', lease_expires_at = NULL WHERE id='e2e-deployment'");
  const leased = await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-worker-4" }, deps(risingCandles(48)));
  assert.ok(leased, "风控阻断的跟随仍应被租走以便离场");
  assert.notEqual(leased.status, "not_admitted");
});

test("第 2 步：账本盈亏接上周结算", async () => {
  // 在此之前 settleFollowContractWeek 的 weekNetPnl 由调用方给，而没有任何调用方——
  // 社区策略跑不出成交。现在盈亏来自真实的成交回执。
  const week = { weekStart: "2026-07-27T00:00:00.000Z", weekEnd: "2026-08-03T00:00:00.000Z" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pnl = await loadFollowWeekRealizedPnl(client, { portfolioId: "e2e-portfolio", ...week });
    // 只有买入成交时已实现盈亏为 0——浮盈不计费。
    assert.equal(typeof pnl.weekNetPnl, "string");
    assert.equal(typeof pnl.cumulativeNetPnl, "string");

    const settlement = await settleFollowWeekFromBook(client, {
      contractId: "e2e-contract", portfolioId: "e2e-portfolio", ...week,
    });
    await client.query("COMMIT");
    assert.equal(settlement.contractId, "e2e-contract");
    // 只买未卖时本周没有已实现盈利，因此零费用——浮盈不计费，它可能在下一周变成浮亏。
    assert.equal(Number(settlement.feeAmount), 0);
    assert.equal(settlement.status, "no_fee");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

test("累计盈亏取周末之前全部回执，不只本周", async () => {
  // 高水位线比的是累计值。只算本周会让每一周都从零开始，亏损周之后的反弹被重复计费。
  const client = await pool.connect();
  try {
    const wide = await loadFollowWeekRealizedPnl(client, {
      portfolioId: "e2e-portfolio",
      weekStart: "2026-08-03T00:00:00.000Z", weekEnd: "2026-08-10T00:00:00.000Z",
    });
    const early = await loadFollowWeekRealizedPnl(client, {
      portfolioId: "e2e-portfolio",
      weekStart: "2026-07-27T00:00:00.000Z", weekEnd: "2026-08-03T00:00:00.000Z",
    });
    // 后一周的本周盈亏为 0（没有新成交），但累计值必须包含之前那笔。
    assert.equal(Number(wide.weekNetPnl), 0);
    assert.equal(Number(wide.cumulativeNetPnl), Number(early.cumulativeNetPnl));
  } finally {
    client.release();
  }
});

test("第 3 步：风控触发时写回订阅状态并留下事件", async () => {
  // 只挡开仓不写回状态，客户与运营在界面上完全看不出这个跟随已经被风控停了——他们看到
  // 的仍是「运行中，只是一直不开仓」。
  await pool.query(`
    UPDATE strategy_subscriptions SET status='active', paused_by=NULL, paused_at=NULL,
           ended_by=NULL, ended_reason=NULL WHERE id='e2e-sub';
    UPDATE strategy_deployments SET next_cycle_at='2026-07-31T00:00:00Z', lease_expires_at=NULL,
           last_candle_close_at=NULL WHERE id='e2e-deployment';
    -- 已实现净亏损 -1,500 / 本金 10,000 = 15% 回撤，超过合同止损线 10%。
    UPDATE strategy_follow_paper_portfolios SET realized_net_pnl_usdt=-1500 WHERE id='e2e-portfolio';
  `);
  await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-risk" }, deps(risingCandles(60)));

  const subscription = await pool.query(
    "SELECT status,paused_by,paused_reason FROM strategy_subscriptions WHERE id='e2e-sub'");
  assert.equal(subscription.rows[0].status, "risk_blocked");
  assert.equal(subscription.rows[0].paused_by, "automated_risk");
  assert.match(subscription.rows[0].paused_reason, /drawdown_stop_loss/);

  const events = await pool.query(`
    SELECT authority,action,triggered_rules_json,evidence_json FROM strategy_follow_risk_events
     WHERE subscription_id='e2e-sub' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(events.rows[0].authority, "automated_risk");
  assert.equal(events.rows[0].action, "pause");
  assert.deepEqual(events.rows[0].triggered_rules_json, ["drawdown_stop_loss"]);
  // 证据带实际值与阈值，客户能核对而不是只看到「被风控停了」。
  assert.equal(events.rows[0].evidence_json.stopLossPct, 10);
});

test("已阻断的跟随不重复写事件", async () => {
  // 否则每一轮都会追加一条同样的事件。
  const before = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_follow_risk_events WHERE subscription_id='e2e-sub'");
  await pool.query("UPDATE strategy_deployments SET next_cycle_at='2026-07-31T00:00:00Z', lease_expires_at=NULL, last_candle_close_at=NULL WHERE id='e2e-deployment'");
  await processNextFollowRuntimeDeployment(pool, { workerId: "e2e-risk-2" }, deps(risingCandles(72)));
  const after = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_follow_risk_events WHERE subscription_id='e2e-sub'");
  assert.equal(after.rows[0].count, before.rows[0].count);
});
