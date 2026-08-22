import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import {
  applyKillSwitchRelease,
  engageKillSwitch,
  listActiveKillSwitches,
  listKillSwitches,
  requestKillSwitchRelease,
} from "../lib/execution/kill-switch-repository.ts";

// 熔断的核心是一条刻意的不对称：挂上单人即时，摘除走 maker/checker。
// 这个测试文件主要就是把那条不对称钉住。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `exec_kill_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL("../postgres/migrations/0051_execution_kill_switches.sql", import.meta.url), "utf8"));
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

test("挂上熔断是单人即时生效的", async () => {
  // 出事的时候没有时间等第二个人批准。
  const result = await engageKillSwitch(pool, {
    dimension: "exchange", scopeValue: "okx", reason: "OKX 撮合异常", engagedBy: "ops-1",
  });
  assert.equal(result.created, true);
  const active = await listActiveKillSwitches(pool);
  assert.equal(active.length, 1);
  assert.equal(active[0].scopeValue, "okx");
});

test("两个运营同时按下同一个开关，结果只有一个", async () => {
  const again = await engageKillSwitch(pool, {
    dimension: "exchange", scopeValue: "okx", reason: "我也发现了", engagedBy: "ops-2",
  });
  assert.equal(again.created, false, "不是失败，只是已经挂上了");
  assert.equal((await listActiveKillSwitches(pool)).length, 1);
});

test("没有解除申请时不能直接摘掉", async () => {
  const [entry] = await listKillSwitches(pool, { activeOnly: true });
  const result = await applyKillSwitchRelease(pool, { id: entry.id, releasedBy: "ops-2" });
  assert.equal(result.released, false);
  assert.equal(result.reason, "KILL_SWITCH_RELEASE_NOT_REQUESTED");
});

test("发起解除申请后开关仍然生效", async () => {
  // 申请不等于解除。恢复交易是把风险放回去，必须等第二双眼睛。
  const [entry] = await listKillSwitches(pool, { activeOnly: true });
  const requested = await requestKillSwitchRelease(pool, {
    id: entry.id, requestedBy: "ops-1", approvalRequestId: "req-1",
  });
  assert.equal(requested.requested, true);
  assert.equal((await listActiveKillSwitches(pool)).length, 1, "申请期间必须继续挡住开仓");
});

test("发起人不能批准自己的解除申请", async () => {
  const [entry] = await listKillSwitches(pool, { activeOnly: true });
  const result = await applyKillSwitchRelease(pool, { id: entry.id, releasedBy: "ops-1" });
  assert.equal(result.released, false);
  assert.equal(result.reason, "KILL_SWITCH_SELF_APPROVAL_FORBIDDEN");
  assert.equal((await listActiveKillSwitches(pool)).length, 1);
});

test("由另一个人批准后才真正解除", async () => {
  const [entry] = await listKillSwitches(pool, { activeOnly: true });
  const result = await applyKillSwitchRelease(pool, { id: entry.id, releasedBy: "ops-2" });
  assert.equal(result.released, true);
  assert.equal((await listActiveKillSwitches(pool)).length, 0);
});

test("解除记录保留了是谁发起、谁批准", async () => {
  const [entry] = await listKillSwitches(pool, {});
  assert.equal(entry.active, false);
  assert.equal(entry.engagedBy, "ops-1");
  assert.equal(entry.releasedBy, "ops-2");
  assert.ok(entry.releasedAt);
});

test("已解除的熔断不得复活，要停必须重新挂一条", async () => {
  // 复活会绕过「挂上要写当次原因和责任人」这条。
  const [entry] = await listKillSwitches(pool, {});
  await assert.rejects(
    () => pool.query("UPDATE execution_kill_switches SET active = true WHERE id = $1", [entry.id]),
    /不得复活/,
  );
});

test("解除之后可以对同一对象重新挂上", async () => {
  const again = await engageKillSwitch(pool, {
    dimension: "exchange", scopeValue: "okx", reason: "又出问题了", engagedBy: "ops-3",
  });
  assert.equal(again.created, true);
  assert.equal((await listActiveKillSwitches(pool)).length, 1);
});

test("三个维度可以同时生效，互不干扰", async () => {
  await engageKillSwitch(pool, { dimension: "account", scopeValue: "acct-1", reason: "客户申诉", engagedBy: "ops-1" });
  await engageKillSwitch(pool, { dimension: "strategy", scopeValue: "trend-v1", reason: "回撤异常", engagedBy: "ops-1" });
  const active = await listActiveKillSwitches(pool);
  assert.equal(active.length, 3);
  assert.deepEqual(new Set(active.map((entry) => entry.dimension)), new Set(["exchange", "account", "strategy"]));
});
