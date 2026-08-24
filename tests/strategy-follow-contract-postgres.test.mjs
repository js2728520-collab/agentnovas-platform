import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  DEFAULT_FOLLOW_FEE_BPS,
  loadFollowContract,
  pinFollowContract,
  resolveCustomerFollowFeeBps,
} from "../lib/strategy-follow-contract.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `follow_contract_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

const contract = (overrides = {}) => ({
  subscriptionId: "follow-subscription",
  strategyId: "follow-strategy",
  customerId: "follow-customer",
  authorUserId: "follow-author",
  strategyVersionId: "follow-version",
  strategyVersion: 1,
  performanceFeeBps: 1_800,
  publicationMode: "marketplace",
  risk: { capitalPct: 3, stopLossPct: 10 },
  disclosureText: "跟单风险披露 v1：模拟盘结果不代表真实收益。",
  ...overrides,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-follow-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "follow-contract-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('follow-author','follow-author@quality.invalid','test-only-hash','customer','active'),
      ('follow-customer','follow-customer@quality.invalid','test-only-hash','customer','active'),
      ('follow-other','follow-other@quality.invalid','test-only-hash','customer','active'),
      ('follow-third','follow-third@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('follow-strategy','follow-author','跟单策略','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
      VALUES ('follow-subscription','follow-strategy','follow-customer','active','2026-08-01T00:00:00Z','follow-version','paper','active');
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("合同固定客户当时同意的版本、费率与风险参数", async () => {
  const pinned = await pinFollowContract(pool, contract());
  assert.equal(pinned.strategyVersionId, "follow-version");
  assert.equal(pinned.performanceFeeBps, 1_800);
  assert.equal(pinned.platformShareBps, 5_000);
  assert.deepEqual(pinned.risk, { capitalPct: 3, stopLossPct: 10 });
  // 披露正文不入库，摘要足以证明客户当时看到的是哪一份。
  assert.match(pinned.disclosureSha256, /^[a-f0-9]{64}$/);

  // 重复确认返回同一份，不产生第二份合同。
  const again = await pinFollowContract(pool, contract({ performanceFeeBps: 2_000 }));
  assert.equal(again.id, pinned.id);
  assert.equal(again.performanceFeeBps, 1_800, "重复确认不得改写已固定的费率");
});

test("合同不可改写——这是客户同意了什么的唯一记录", async () => {
  // 能改写它，就能在事后把一位客户的费率从 18% 改成 20%，而所有下游计算都会照着新值算，
  // 没有任何地方会报错。
  await assert.rejects(
    pool.query("UPDATE strategy_follow_contracts SET performance_fee_bps=2000 WHERE subscription_id='follow-subscription'"),
    (error) => /FOLLOW_CONTRACT_IMMUTABLE/.test(error.message),
  );
  await assert.rejects(
    pool.query("DELETE FROM strategy_follow_contracts WHERE subscription_id='follow-subscription'"),
    (error) => /FOLLOW_CONTRACT_IMMUTABLE/.test(error.message),
  );
  const unchanged = await loadFollowContract(pool, "follow-subscription");
  assert.equal(unchanged.performanceFeeBps, 1_800);
});

test("一次订阅只有一份合同", async () => {
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_follow_contracts(
        id,subscription_id,strategy_id,customer_id,author_user_id,strategy_version_id,
        strategy_version,performance_fee_bps,platform_share_bps,publication_mode,risk_json,disclosure_sha256
      ) VALUES ('second','follow-subscription','follow-strategy','follow-customer','follow-author',
        'follow-version',1,2000,5000,'marketplace','{}'::jsonb,repeat('a',64))
    `),
    (error) => /duplicate key|unique/i.test(error.message),
  );
});

test("没有会员权益时回落到 P-06 的默认费率——方向是更贵不是更便宜", async () => {
  const bps = await resolveCustomerFollowFeeBps(pool, "follow-other");
  assert.equal(bps, DEFAULT_FOLLOW_FEE_BPS);
  assert.equal(bps, 2_000, "没有会员就没有优惠，这与「优惠是会员权益」一致");
});

test("下架不改历史订阅，但客户随时可以自己停止", async () => {
  // 「下架」是让策略不再对新客户可见，不是终止已有跟随。
  await pool.query("UPDATE community_strategies SET status='delisted' WHERE id='follow-strategy'");

  const subscription = await pool.query(
    "SELECT status FROM strategy_subscriptions WHERE id='follow-subscription'",
  );
  assert.equal(subscription.rows[0].status, "active", "下架不得改动订阅状态");
  const stillThere = await loadFollowContract(pool, "follow-subscription");
  assert.equal(stillThere.performanceFeeBps, 1_800, "下架不得影响已固定的合同");

  // 不写理由的结束正是「下架时顺手改掉」的形态：没人知道是谁、因为什么结束了客户的跟随。
  await assert.rejects(
    pool.query("UPDATE strategy_subscriptions SET status='ended' WHERE id='follow-subscription'"),
    (error) => /SUBSCRIPTION_END_REASON_REQUIRED/.test(error.message),
  );
  // 光把理由填成 change_request 也不行，必须真的走完通知缓冲期。
  await assert.rejects(
    pool.query("UPDATE strategy_subscriptions SET status='ended',ended_reason='change_request' WHERE id='follow-subscription'"),
    (error) => /SUBSCRIPTION_CHANGE_REQUEST_NOT_COMPLETED/.test(error.message),
  );

  // 但客户自己停止必须畅通——一个把客户困在已下架策略里的守卫比它要防的问题更糟。
  await pool.query(
    "UPDATE strategy_subscriptions SET status='ended',ended_reason='customer_stopped' WHERE id='follow-subscription'",
  );
  const ended = await pool.query(
    "SELECT status,ended_reason FROM strategy_subscriptions WHERE id='follow-subscription'",
  );
  assert.equal(ended.rows[0].status, "ended");
  assert.equal(ended.rows[0].ended_reason, "customer_stopped");
});

test("走完通知缓冲期后可按变更申请终止", async () => {
  await pool.query(`
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
    VALUES ('follow-subscription-2','follow-strategy','follow-other','active','2026-08-01T00:00:00Z','follow-version','paper','active');
    INSERT INTO strategy_change_requests(id,strategy_id,author_user_id,action,reason,status,requested_at,notice_ends_at,completed_at)
    VALUES ('change-1','follow-strategy','follow-author','delist','作者申请下架','completed',
            '2026-08-01T00:00:00Z','2026-08-08T00:00:00Z','2026-08-08T00:00:00Z');
  `);
  await pool.query(
    "UPDATE strategy_subscriptions SET status='ended',ended_reason='change_request' WHERE id='follow-subscription-2'",
  );
  const ended = await pool.query("SELECT status FROM strategy_subscriptions WHERE id='follow-subscription-2'");
  assert.equal(ended.rows[0].status, "ended");
});

test("结束理由只允许四种，且必须说得出是谁结束的", async () => {
  await pool.query(`
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
    VALUES ('follow-subscription-3','follow-strategy','follow-third','active','2026-08-01T00:00:00Z','follow-version','paper','active')
  `);
  await assert.rejects(
    pool.query("UPDATE strategy_subscriptions SET status='ended',ended_reason='strategy_delisted' WHERE id='follow-subscription-3'"),
    (error) => /strategy_subscriptions_ended_reason_check/.test(error.message),
    "「因为下架所以结束」根本不在允许的理由里",
  );
});

test("作者分账有争议状态，且状态与时间戳必须自洽", async () => {
  // P-06：已结算的分成不退。因此 disputed 是「先冻住不付」，不是「退款」。
  const seedRevenueEvent = (id) => pool.query(`
    INSERT INTO revenue_events(id,customer_id,type,source_id,amount_usdt,confirmed_at,attribution_status,rule_version)
    VALUES ($1,'follow-customer','strategy_performance_fee',$1,10,'2026-08-01T00:00:00Z','confirmed','v1')
  `, [id]);
  const insert = async (id, extra) => { await seedRevenueEvent(id); return pool.query(`
    INSERT INTO strategy_author_earnings(
      id,strategy_id,author_user_id,revenue_event_id,fee_rate,gross_performance_fee_usdt,
      platform_fee_usdt,author_amount_usdt,collection_confirmed_at,period_month,period_week_start${extra.columns}
    ) VALUES ($1,'follow-strategy','follow-author',$1,0.2,20,10,10,'2026-08-01T00:00:00Z','2026-08','2026-07-27'${extra.values})
  `, [id]); };

  await insert("earning-clean", { columns: "", values: "" });
  // 有争议状态却没有开启时间——自相矛盾的记录会让「这笔到底有没有争议」有两个答案。
  await assert.rejects(
    insert("earning-broken", { columns: ",dispute_status", values: ",'opened'" }),
    (error) => /strategy_author_earnings_dispute_check/.test(error.message),
  );
  // 已裁决却没有裁决时间，同样拒绝。
  await assert.rejects(
    insert("earning-broken-2", {
      columns: ",dispute_status,dispute_opened_at", values: ",'upheld','2026-08-02T00:00:00Z'",
    }),
    (error) => /strategy_author_earnings_dispute_check/.test(error.message),
  );
  await insert("earning-disputed", {
    columns: ",dispute_status,dispute_opened_at,dispute_reason",
    values: ",'opened','2026-08-02T00:00:00Z','客户主张成交价异常'",
  });
  const disputed = await pool.query("SELECT dispute_status FROM strategy_author_earnings WHERE id='earning-disputed'");
  assert.equal(disputed.rows[0].dispute_status, "opened");
});

test("每（客户, 策略）一条高水位线", async () => {
  // 与官方卡按客户合并的那条刻意不同：作者拿到的应该是自己策略真实创造的收益，
  // 不被客户跟的其它作者的亏损抵消——否则作者的收入取决于客户又跟了谁。
  const columns = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='strategy_follow_high_water_marks'
     ORDER BY column_name
  `, [schema]);
  assert.deepEqual(columns.rows.map((row) => row.column_name),
    ["created_at", "cumulative_net_pnl", "customer_id", "high_water_mark", "strategy_id", "updated_at"]
      .filter((name) => name !== "created_at"));
});
