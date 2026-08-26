import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { pinFollowContract } from "../lib/strategy-follow-contract.ts";
import { processNextFollowSettlement, settleFollowContractWeek } from "../lib/strategy-follow-settlement-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `follow_settle_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
let migrationDirectory;
let contractId;

const WEEK_1 = { weekStart: "2026-08-24T00:00:00.000Z", weekEnd: "2026-08-31T00:00:00.000Z" };
const WEEK_2 = { weekStart: "2026-08-31T00:00:00.000Z", weekEnd: "2026-09-07T00:00:00.000Z" };
const WEEK_3 = { weekStart: "2026-09-07T00:00:00.000Z", weekEnd: "2026-09-14T00:00:00.000Z" };

async function settle(input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await settleFollowContractWeek(client, { contractId, ...input });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-settle-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "follow-settlement-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('settle-author','settle-author@quality.invalid','test-only-hash','customer','active'),
      ('settle-customer','settle-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('settle-strategy','settle-author','结算策略','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
      VALUES ('settle-subscription','settle-strategy','settle-customer','active','2026-08-01T00:00:00Z','settle-version','live','active');
  `);
  const contract = await pinFollowContract(pool, {
    subscriptionId: "settle-subscription",
    strategyId: "settle-strategy",
    customerId: "settle-customer",
    authorUserId: "settle-author",
    strategyVersionId: "settle-version",
    strategyVersion: 1,
    performanceFeeBps: 1_800,
    publicationMode: "marketplace",
    risk: { capitalPct: 3 },
    disclosureText: "跟单风险披露 v1",
  });
  contractId = contract.id;
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("盈利周按合同费率出单并推进高水位线", async () => {
  const result = await settle({ ...WEEK_1, weekNetPnl: "100", cumulativeNetPnl: "100" });
  assert.equal(result.replayed, false);
  assert.equal(result.feeAmount, "18.000000000000000000");
  assert.equal(result.platformAmount, "9.000000000000000000");
  assert.equal(result.authorAmount, "9.000000000000000000");
  assert.equal(result.status, "pending_review");

  const mark = await pool.query(
    "SELECT high_water_mark::text FROM strategy_follow_high_water_marks WHERE customer_id='settle-customer' AND strategy_id='settle-strategy'",
  );
  assert.equal(Number(mark.rows[0].high_water_mark), 100);
});

test("重复结算返回原单，且不再推进高水位线", async () => {
  // 推进两次会让下一周的计费基准凭空抬高：客户少付一笔、作者少拿一笔，
  // 而且没有任何地方会报错。
  const first = await pool.query(
    "SELECT high_water_mark::text FROM strategy_follow_high_water_marks WHERE customer_id='settle-customer' AND strategy_id='settle-strategy'",
  );
  const replay = await settle({ ...WEEK_1, weekNetPnl: "100", cumulativeNetPnl: "200" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.feeAmount, "18.000000000000000000", "重放不得按新数字重算");

  const after = await pool.query(
    "SELECT high_water_mark::text FROM strategy_follow_high_water_marks WHERE customer_id='settle-customer' AND strategy_id='settle-strategy'",
  );
  assert.equal(after.rows[0].high_water_mark, first.rows[0].high_water_mark);

  const count = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_follow_settlements WHERE contract_id=$1 AND week_start=$2",
    [contractId, WEEK_1.weekStart],
  );
  assert.equal(count.rows[0].count, 1, "同一周不得出两张单");
});

test("亏损周零费用出单，高水位线不下降", async () => {
  const result = await settle({ ...WEEK_2, weekNetPnl: "-40", cumulativeNetPnl: "60" });
  assert.equal(result.feeAmount, "0.000000000000000000");
  // 没有钱要审的东西不该占审批队列。
  assert.equal(result.status, "no_fee");
  assert.equal(Number(result.nextHighWaterMark), 100);

  const mark = await pool.query(
    "SELECT high_water_mark::text FROM strategy_follow_high_water_marks WHERE customer_id='settle-customer' AND strategy_id='settle-strategy'",
  );
  assert.equal(Number(mark.rows[0].high_water_mark), 100, "亏损周之后高水位线必须保持");
});

test("反弹周只对超过高水位线的部分计费", async () => {
  // 60 → 130：只有 100→130 这 30 计费，60→100 是补回。
  const result = await settle({ ...WEEK_3, weekNetPnl: "70", cumulativeNetPnl: "130" });
  assert.equal(Number(result.feeAmount), 5.4);
  assert.equal(Number(result.priorHighWaterMark), 100);
  assert.equal(Number(result.nextHighWaterMark), 130);
});

test("数据库自己挡住分账不守恒的单", async () => {
  // 应用层那个函数保证守恒，但守恒是账本的要求（INV-4），不该只由一段代码保证。
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_follow_settlements(
        id,contract_id,customer_id,strategy_id,author_user_id,week_start,week_end,
        week_net_pnl,cumulative_net_pnl,prior_high_water_mark,next_high_water_mark,
        eligible_profit,loss_carry,fee_bps,fee_amount,platform_amount,author_amount
      ) VALUES ('broken',$1,'settle-customer','settle-strategy','settle-author',
        '2026-09-14T00:00:00Z','2026-09-21T00:00:00Z',100,100,0,100,100,0,1800,18,9,8)
    `, [contractId]),
    (error) => /platform_amount \+ author_amount = fee_amount|check constraint/i.test(error.message),
  );

  // 高水位线下降的单同样拒绝。
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_follow_settlements(
        id,contract_id,customer_id,strategy_id,author_user_id,week_start,week_end,
        week_net_pnl,cumulative_net_pnl,prior_high_water_mark,next_high_water_mark,
        eligible_profit,loss_carry,fee_bps,fee_amount,platform_amount,author_amount
      ) VALUES ('broken-hwm',$1,'settle-customer','settle-strategy','settle-author',
        '2026-09-14T00:00:00Z','2026-09-21T00:00:00Z',-10,90,100,90,0,10,1800,0,0,0)
    `, [contractId]),
    (error) => /next_high_water_mark >= prior_high_water_mark|check constraint/i.test(error.message),
  );

  // 周长度必须是 7 天。
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_follow_settlements(
        id,contract_id,customer_id,strategy_id,author_user_id,week_start,week_end,
        week_net_pnl,cumulative_net_pnl,prior_high_water_mark,next_high_water_mark,
        eligible_profit,loss_carry,fee_bps,fee_amount,platform_amount,author_amount
      ) VALUES ('broken-week',$1,'settle-customer','settle-strategy','settle-author',
        '2026-09-14T00:00:00Z','2026-09-20T00:00:00Z',0,130,130,130,0,0,1800,0,0,0)
    `, [contractId]),
    (error) => /week_end = week_start|check constraint/i.test(error.message),
  );
});

test("金额不可改写，状态可以流转", async () => {
  const row = await pool.query(
    "SELECT id FROM strategy_follow_settlements WHERE contract_id=$1 AND week_start=$2",
    [contractId, WEEK_1.weekStart],
  );
  const id = row.rows[0].id;
  // 能改金额就能事后调整已经出过的账，而下游账本分录已按原值记过了。
  await assert.rejects(
    pool.query("UPDATE strategy_follow_settlements SET fee_amount=20,platform_amount=10,author_amount=10 WHERE id=$1", [id]),
    (error) => /FOLLOW_SETTLEMENT_AMOUNTS_IMMUTABLE/.test(error.message),
  );
  await assert.rejects(
    pool.query("DELETE FROM strategy_follow_settlements WHERE id=$1", [id]),
    (error) => /FOLLOW_SETTLEMENT_IMMUTABLE/.test(error.message),
  );
  // 状态流转是正常操作。
  await pool.query("UPDATE strategy_follow_settlements SET status='approved' WHERE id=$1", [id]);
  const updated = await pool.query("SELECT status FROM strategy_follow_settlements WHERE id=$1", [id]);
  assert.equal(updated.rows[0].status, "approved");
});

test("并发结算同一周只出一张单", async () => {
  // 两个 Worker 同时结算会各自读到同一个旧高水位线，于是同一段涨幅被收两次费。
  const week = { weekStart: "2026-09-14T00:00:00.000Z", weekEnd: "2026-09-21T00:00:00.000Z" };
  const results = await Promise.allSettled([
    settle({ ...week, weekNetPnl: "50", cumulativeNetPnl: "180" }),
    settle({ ...week, weekNetPnl: "50", cumulativeNetPnl: "180" }),
  ]);
  // 允许两种结局：一方成功另一方重放（后者的幂等检查看到了已提交的单），或一方成功
  // 另一方撞唯一索引失败。不允许的是两方都算了一遍——那正是高水位线被推进两次的形态。
  const fresh = results.filter((entry) => entry.status === "fulfilled" && entry.value.replayed === false);
  assert.equal(fresh.length, 1, `恰好一次真实结算：${JSON.stringify(results)}`);
  for (const entry of results) {
    if (entry.status === "rejected") {
      assert.match(String(entry.reason?.message ?? entry.reason), /duplicate key|unique/i,
        "并发失败只应是撞唯一索引，不该是别的错误");
    }
  }

  const count = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_follow_settlements WHERE contract_id=$1 AND week_start=$2",
    [contractId, week.weekStart],
  );
  assert.equal(count.rows[0].count, 1, "并发下同一周仍只应有一张单");

  const mark = await pool.query(
    "SELECT high_water_mark::text FROM strategy_follow_high_water_marks WHERE customer_id='settle-customer' AND strategy_id='settle-strategy'",
  );
  assert.equal(Number(mark.rows[0].high_water_mark), 180, "高水位线只应推进一次");
});

test("paper 跟随一分不收，即便这一周赚了", async () => {
  // 需求方 2026-08-24 确认：paper 跟单不收费。这条要在库层端到端验一遍——域层的判定
  // 再对，只要 run_mode 没被读出来传下去，实际仍会收费。
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status)
      VALUES ('paper-customer','paper-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
      VALUES ('paper-subscription','settle-strategy','paper-customer','active','2026-08-01T00:00:00Z','settle-version','paper','active');
    INSERT INTO strategy_follow_contracts(
      id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
      strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256
    ) VALUES ('paper-contract','paper-subscription','settle-strategy','paper-customer','settle-author','settle-version',
      1,1800,5000,'marketplace','{"capitalPct":3}'::jsonb,repeat('c',64));
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await settleFollowContractWeek(client, {
      contractId: "paper-contract",
      weekStart: "2026-08-24T00:00:00.000Z", weekEnd: "2026-08-31T00:00:00.000Z",
      weekNetPnl: "100", cumulativeNetPnl: "100",
    });
    await client.query("COMMIT");
    assert.equal(Number(result.feeAmount), 0);
    assert.equal(Number(result.platformAmount), 0);
    assert.equal(Number(result.authorAmount), 0);
    assert.equal(result.status, "no_fee");
    // 盈亏仍然记录、高水位线仍然推进——否则将来转实盘时基准从零开始，客户会为一段
    // 模拟期的涨幅重复付费。
    assert.equal(Number(result.nextHighWaterMark), 100);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

test("run_mode 缺失时按不收费处理", async () => {
  // 缺数据时的默认方向必须指向不收钱。
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status)
      VALUES ('null-customer','null-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,runtime_status)
      VALUES ('null-subscription','settle-strategy','null-customer','active','2026-08-01T00:00:00Z','settle-version','active');
    INSERT INTO strategy_follow_contracts(
      id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
      strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256
    ) VALUES ('null-contract','null-subscription','settle-strategy','null-customer','settle-author','settle-version',
      1,1800,5000,'marketplace','{"capitalPct":3}'::jsonb,repeat('d',64));
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await settleFollowContractWeek(client, {
      contractId: "null-contract",
      weekStart: "2026-08-24T00:00:00.000Z", weekEnd: "2026-08-31T00:00:00.000Z",
      weekNetPnl: "100", cumulativeNetPnl: "100",
    });
    await client.query("COMMIT");
    assert.equal(Number(result.feeAmount), 0);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

test("Worker 逐周补齐未结算的周，已走完的才结算", async () => {
  // 对一个还没结束的周计费，等于按半周的盈亏收全周的费。
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status)
      VALUES ('scan-customer','scan-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
      VALUES ('scan-subscription','settle-strategy','scan-customer','active','2026-08-01T00:00:00Z','settle-version','paper','active');
    INSERT INTO strategy_follow_paper_portfolios(id,subscription_id,customer_id,strategy_id)
      VALUES ('scan-portfolio','scan-subscription','scan-customer','settle-strategy');
    INSERT INTO strategy_follow_contracts(
      id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
      strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256,confirmed_at
    ) VALUES ('scan-contract','scan-subscription','settle-strategy','scan-customer','settle-author','settle-version',
      1,1800,5000,'marketplace','{"capitalPct":3}'::jsonb,repeat('e',64),'2026-08-03T00:00:00Z');
  `);

  // 2026-08-03 是周一。到 08-17 为止走完了两周：08-03～08-10 与 08-10～08-17。
  const asOf = new Date("2026-08-19T00:00:00.000Z");
  const first = await processNextFollowSettlement(pool, { now: asOf });
  assert.equal(first.contractId, "scan-contract");
  assert.equal(first.weekStart, "2026-08-03T00:00:00.000Z", "最早的未结算周先结");

  const second = await processNextFollowSettlement(pool, { now: asOf });
  assert.equal(second.weekStart, "2026-08-10T00:00:00.000Z");

  // 第三周（08-17～08-24）在 08-19 时还没走完，不该被结算。
  const third = await processNextFollowSettlement(pool, { now: asOf });
  assert.equal(third, null, "未走完的周不得结算");

  const rows = await pool.query(
    "SELECT count(*)::int AS count FROM strategy_follow_settlements WHERE contract_id='scan-contract'");
  assert.equal(rows.rows[0].count, 2);
});

test("模拟盘的周也结算，只是不收费", async () => {
  // 盈亏要记录、高水位线要推进——否则将来转实盘时基准从零开始，客户会为一段模拟期的
  // 涨幅重复付费（INV-5）。
  const settlements = await pool.query(`
    SELECT fee_amount::text, status FROM strategy_follow_settlements
     WHERE contract_id='scan-contract' ORDER BY week_start`);
  assert.equal(settlements.rowCount, 2);
  for (const row of settlements.rows) {
    assert.equal(Number(row.fee_amount), 0);
    assert.equal(row.status, "no_fee");
  }
});
