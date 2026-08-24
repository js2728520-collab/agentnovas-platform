import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { FOLLOW_LIFECYCLE_STATES, STOP_AUTHORITIES } from "../packages/domain/src/strategy-follow-lifecycle.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `follow_lifecycle_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

const setStatus = (id, columns) => pool.query(
  `UPDATE strategy_subscriptions SET ${columns} WHERE id = $1`, [id]);

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-lifecycle-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "follow-lifecycle-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('life-author','life-author@quality.invalid','test-only-hash','customer','active'),
      ('life-customer','life-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('life-strategy','life-author','生命周期策略','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode)
      VALUES ('life-subscription','life-strategy','life-customer','active','2026-08-01T00:00:00Z','life-version','paper');
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("状态清单三份副本一致", async () => {
  const directory = new URL("../postgres/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  let allowed = null;
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), "utf8");
    for (const match of sql.matchAll(/strategy_subscriptions_status_check CHECK \(status IN \(([^)]*)\)\)/g)) {
      allowed = [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
    }
  }
  assert.ok(allowed, "未能解析出 strategy_subscriptions_status_check");
  assert.deepEqual([...FOLLOW_LIFECYCLE_STATES].sort(), [...allowed].sort());

  const schemaSource = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const start = schemaSource.indexOf("export const strategySubscriptions");
  const block = schemaSource.slice(start, schemaSource.indexOf("});", start));
  const drizzle = [...block.match(/status: text\("status", \{ enum: \[([^\]]*)\] \}\)/)[1]
    .matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...drizzle].sort(), [...allowed].sort());
});

test("旧状态被迁移，且约束拒绝旧值", async () => {
  await assert.rejects(
    setStatus("life-subscription", "status='ended'"),
    (error) => /strategy_subscriptions_status_check/.test(error.message),
  );
  await assert.rejects(
    setStatus("life-subscription", "status='pending'"),
    (error) => /strategy_subscriptions_status_check/.test(error.message),
  );
});

test("暂停态必须说得出是谁停的", async () => {
  // 没有这一列，「暂停」与「风控阻断」就只是两个措辞不同的同一件事。
  await assert.rejects(
    setStatus("life-subscription", "status='paused'"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
  );
  await assert.rejects(
    setStatus("life-subscription", "status='risk_blocked', paused_by='automated_risk'"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
    "有 paused_by 就必须有 paused_at",
  );
  await setStatus("life-subscription", "status='risk_blocked', paused_by='automated_risk', paused_at=now()");
});

test("风控阻断只能由风控三方造成，客户暂停不得被记成风控阻断", async () => {
  await assert.rejects(
    setStatus("life-subscription", "status='risk_blocked', paused_by='customer', paused_at=now()"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
  );
  await assert.rejects(
    setStatus("life-subscription", "status='paused', paused_by='automated_risk', paused_at=now()"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
  );
});

test("非暂停态不得残留 paused_by", async () => {
  // 残留会让下一次恢复按一个早已失效的权威判定。
  await assert.rejects(
    setStatus("life-subscription", "status='active', paused_by='automated_risk', paused_at=now()"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
  );
  await setStatus("life-subscription", "status='active', paused_by=NULL, paused_at=NULL");
});

test("终止必须说得出理由与是哪一方", async () => {
  // PRD 6.6 的四方：说不出是谁终止的跟随，事后无法复盘。
  await assert.rejects(
    setStatus("life-subscription", "status='stopped', ended_reason='customer_stopped'"),
    (error) => /SUBSCRIPTION_END_AUTHORITY_REQUIRED/.test(error.message),
  );
  await assert.rejects(
    setStatus("life-subscription", "status='stopped', ended_by='customer'"),
    (error) => /SUBSCRIPTION_END_REASON_REQUIRED/.test(error.message),
  );
  await setStatus("life-subscription", "status='stopped', ended_by='customer', ended_reason='customer_stopped'");
  const row = await pool.query("SELECT status,ended_by FROM strategy_subscriptions WHERE id='life-subscription'");
  assert.equal(row.rows[0].status, "stopped");
  assert.equal(row.rows[0].ended_by, "customer");
});

test("四方权威取值受约束", async () => {
  await pool.query(`
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,strategy_version_id,run_mode)
    VALUES ('life-subscription-2','life-strategy','life-author','active','life-version','paper')
  `);
  await assert.rejects(
    setStatus("life-subscription-2", "status='risk_blocked', paused_by='admin', paused_at=now()"),
    (error) => /strategy_subscriptions_stop_authority_check/.test(error.message),
  );
  for (const authority of STOP_AUTHORITIES.filter((entry) => entry !== "customer")) {
    await setStatus("life-subscription-2", `status='risk_blocked', paused_by='${authority}', paused_at=now()`);
  }
});

test("客户端路由用状态机判定，不再自己写 if", async () => {
  const route = await readFile(
    new URL("../app/api/strategy-subscriptions/[id]/route.client.ts", import.meta.url), "utf8");
  assert.match(route, /pauseFollow\(subscription\.status, "customer"\)/);
  // 必须传**库里记的** pausedBy。写死成 "customer" 会让客户解除任何风控阻断，而调用
  // 形状看起来完全正常——只断言 resumeFollow 被调用是抓不到的。
  assert.match(route, /pausedBy: subscription\.pausedBy, authority: "customer"/);
  // 风控阻断与「状态不对」报错分开：前者要告诉客户去找运营，后者只是时机不对。
  assert.match(route, /FOLLOW_RISK_BLOCKED/);
  assert.match(route, /该跟随由风控阻断，需要运营风控解除后才能恢复/);
  // Paper 跟随可以恢复；实盘仍然关闭。
  assert.match(route, /subscription\.runMode === "live"/);
  assert.doesNotMatch(route, /当前不能恢复模拟跟单/);
});
