import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import {
  grantLiveRouting,
  listLiveRouting,
  listLiveRoutingGrants,
  requestLiveRouting,
  revokeLiveRouting,
} from "../lib/execution/live-routing-repository.ts";

// 实盘路由是全仓库唯一一处「把保护往回放」的地方，因此它的不对称必须钉死：
// 开通走 maker/checker，关停单人即时。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `exec_routing_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL("../postgres/migrations/0052_execution_live_routing.sql", import.meta.url), "utf8"));
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

test("默认没有任何实盘授权", async () => {
  assert.deepEqual(await listLiveRoutingGrants(pool), []);
});

test("申请开通不会立即生效", async () => {
  const result = await requestLiveRouting(pool, {
    exchange: "OKX", environment: "live", requestedBy: "ops-1",
    note: "首批接入 OKX 现货", approvalRequestId: "req-1",
  });
  assert.ok("id" in result);
  assert.deepEqual(await listLiveRoutingGrants(pool), [], "批准之前必须仍然全关");
});

test("交易所代号被归一成小写", async () => {
  const [row] = await listLiveRouting(pool, {});
  assert.equal(row.exchange, "okx");
});

test("发起人不能批准自己的开通申请", async () => {
  const [row] = await listLiveRouting(pool, {});
  const result = await grantLiveRouting(pool, { id: row.id, grantedBy: "ops-1" });
  assert.equal(result.granted, false);
  assert.equal(result.reason, "LIVE_ROUTING_SELF_APPROVAL_FORBIDDEN");
  assert.deepEqual(await listLiveRoutingGrants(pool), []);
});

test("由另一个人批准后 OKX 实盘才生效", async () => {
  const [row] = await listLiveRouting(pool, {});
  const result = await grantLiveRouting(pool, { id: row.id, grantedBy: "ops-2" });
  assert.equal(result.granted, true);
  assert.deepEqual(await listLiveRoutingGrants(pool), [{ exchange: "okx", environment: "live" }]);
});

test("同一交易所与环境不能重复申请", async () => {
  const result = await requestLiveRouting(pool, {
    exchange: "okx", environment: "live", requestedBy: "ops-3",
    note: "再来一次", approvalRequestId: "req-2",
  });
  assert.deepEqual(result, { conflict: true });
});

test("开通 live 不影响 demo，两者分别授权", async () => {
  const result = await requestLiveRouting(pool, {
    exchange: "okx", environment: "demo", requestedBy: "ops-1",
    note: "模拟盘", approvalRequestId: "req-3",
  });
  assert.ok("id" in result);
  const grants = await listLiveRoutingGrants(pool);
  assert.equal(grants.length, 1, "demo 申请尚未批准，不应出现在生效清单里");
});

test("关停是单人即时的，不需要第二个人同意", async () => {
  // 关停是把风险收回来的方向。
  const rows = await listLiveRouting(pool, {});
  const live = rows.find((row) => row.environment === "live" && row.status === "granted");
  const result = await revokeLiveRouting(pool, { id: live.id, revokedBy: "ops-9", reason: "OKX 撮合异常" });
  assert.equal(result.revoked, true);
  assert.deepEqual(await listLiveRoutingGrants(pool), []);
});

test("待批准的申请也能被直接关停", async () => {
  // 「我们决定先不开了」不该还要走一遍批准流程。
  const rows = await listLiveRouting(pool, {});
  const pending = rows.find((row) => row.status === "pending");
  const result = await revokeLiveRouting(pool, { id: pending.id, revokedBy: "ops-1", reason: "暂缓" });
  assert.equal(result.revoked, true);
});

test("已关停的授权不得复活，要重开必须重新申请", async () => {
  const rows = await listLiveRouting(pool, {});
  await assert.rejects(
    () => pool.query("UPDATE execution_live_routing SET status = 'granted' WHERE id = $1", [rows[0].id]),
    /不得复活/,
  );
});

test("关停之后可以重新申请同一交易所", async () => {
  const result = await requestLiveRouting(pool, {
    exchange: "okx", environment: "live", requestedBy: "ops-1",
    note: "问题已修复，重新开通", approvalRequestId: "req-4",
  });
  assert.ok("id" in result);
});

test("数据库拒绝任何永续授权", async () => {
  // 域层会拒绝一次，数据库再拒绝一次。它不是一个可配置项。
  await assert.rejects(
    () => pool.query(
      `INSERT INTO execution_live_routing (id, exchange, environment, product, requested_by)
       VALUES ('perp', 'okx', 'live', 'usdt_perpetual', 'ops-1')`),
    /product_check/,
  );
});
