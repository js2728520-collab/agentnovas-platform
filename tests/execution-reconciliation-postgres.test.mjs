import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import pg from "pg";

import {
  acknowledgeReconciliationEscalation,
  enqueueReconciliation,
  loadAccountReconciliationState,
} from "../lib/execution/server/reconciliation-repository.ts";
import { processNextReconciliation } from "../lib/execution/server/reconciliation-worker.ts";

// 对账闭环。域层的状态机已有独立单测，这里验证的是它接上数据库之后是否真的成立：
// 登记幂等、租约不撞车、结案不可改写、升级会挡住开仓、确认后放行。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `exec_recon_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

let clock = Date.parse("2026-08-22T12:00:00.000Z");
const now = () => new Date(clock);

function baseInput(overrides = {}) {
  return {
    clientOrderId: "RV0001", accountId: "acct-1", customerId: "cust-1",
    exchange: "okx", symbol: "BTC/USDT", requestedQuantity: 1,
    decisionRoundId: "round-1", portfolioId: "pf-1", intentId: "intent-1",
    now: now(),
    ...overrides,
  };
}

function deps(adapterOverrides = {}) {
  return {
    workerId: "worker-test",
    now,
    async loadCredential() { return { credentials: { apiKey: "k", secretKey: "s" } }; },
    adapterFor: () => ({
      exchange: "okx",
      async placeMarketOrder() { throw new Error("unused"); },
      async getOrderByClientOrderId() { return null; },
      ...adapterOverrides,
    }),
  };
}

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL("../postgres/migrations/0050_execution_reconciliations.sql", import.meta.url), "utf8"));
  // 0061 给结案事实补了手续费。对账推翻回执时它是费用的唯一来源。
  await pool.query(await readFile(new URL("../postgres/migrations/0061_reconciled_fee_amount.sql", import.meta.url), "utf8"));
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

test("重复登记同一笔下单只产生一条记录", async () => {
  // 超时重试本来就会再次走到登记，这不是异常路径。
  const first = await enqueueReconciliation(pool, baseInput());
  const second = await enqueueReconciliation(pool, baseInput());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  const count = await pool.query("SELECT count(*)::int AS n FROM execution_reconciliations WHERE client_order_id = 'RV0001'");
  assert.equal(count.rows[0].n, 1);
});

test("待对账会挡住该品种开仓，但不挡其它品种", async () => {
  const state = await loadAccountReconciliationState(pool, "acct-1");
  assert.deepEqual([...state.pendingSymbols], ["BTC/USDT"]);
  assert.equal(state.hasEscalated, false);
});

test("查到终态订单即结案，成交量如实写入", async () => {
  const result = await processNextReconciliation(pool, deps({
    async getOrderByClientOrderId() {
      return { externalOrderId: "ex-1", state: "filled", filledQuantity: 1, averagePrice: 100, feeAmount: 0 };
    },
  }));
  assert.deepEqual(result, { processed: true, clientOrderId: "RV0001", action: "resolve" });
  const row = (await pool.query("SELECT status, resolved_outcome, filled_quantity, external_order_id FROM execution_reconciliations WHERE client_order_id='RV0001'")).rows[0];
  assert.equal(row.status, "resolved");
  assert.equal(row.resolved_outcome, "filled");
  assert.equal(Number(row.filled_quantity), 1);
  assert.equal(row.external_order_id, "ex-1");
});

test("结案之后不再被对账任务取走", async () => {
  const result = await processNextReconciliation(pool, deps());
  assert.deepEqual(result, { processed: false });
});

test("结案的成交事实不可被改写", async () => {
  // 对账记录是回执的依据，回执是绩效分成的依据。可改写等于已结算的分成可被事后改动。
  await assert.rejects(
    () => pool.query("UPDATE execution_reconciliations SET filled_quantity = 99 WHERE client_order_id='RV0001'"),
    /不可改写/,
  );
});

test("查询持续失败会重试并退避，次数耗尽后升级人工", async () => {
  await enqueueReconciliation(pool, baseInput({ clientOrderId: "RV0002", symbol: "ETH/USDT" }));
  const failing = deps({ async getOrderByClientOrderId() { throw new Error("EXCHANGE_DOWN"); } });

  const actions = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await processNextReconciliation(pool, failing);
    if (!result.processed) break;
    actions.push(result.action);
    // 推进到下一次到期，否则取不到（这正是退避在起作用）。
    clock += 20 * 60_000;
  }
  assert.equal(actions.at(-1), "escalate", `实际序列：${actions.join(",")}`);
  assert.ok(actions.filter((a) => a === "retry").length >= 5, "升级之前必须真的重试过多次");

  const row = (await pool.query("SELECT status, escalation_reason FROM execution_reconciliations WHERE client_order_id='RV0002'")).rows[0];
  assert.equal(row.status, "escalated");
  assert.match(row.escalation_reason, /QUERY_FAILED/);
});

test("升级人工后该账户全面停止开新仓", async () => {
  const state = await loadAccountReconciliationState(pool, "acct-1");
  assert.equal(state.hasEscalated, true);
});

test("运维确认处理后不再挡住开仓", async () => {
  // 否则一次故障会永久冻结这个账户。
  const result = await acknowledgeReconciliationEscalation(pool, {
    clientOrderId: "RV0002", actor: "ops-1", now: now(),
  });
  assert.equal(result.acknowledged, true);
  const state = await loadAccountReconciliationState(pool, "acct-1");
  assert.equal(state.hasEscalated, false);
});

test("窗口外查不到订单时升级，而不是当成未下单", async () => {
  // 交易所只保留近期订单可查。把「过期不可查」判成「从未下单」会让真实成交被
  // 当成未成交然后重试——重复下单。
  await enqueueReconciliation(pool, baseInput({ clientOrderId: "RV0003", symbol: "SOL/USDT" }));
  clock += 60 * 60_000; // 远超采信窗口
  const result = await processNextReconciliation(pool, deps({ async getOrderByClientOrderId() { return null; } }));
  assert.equal(result.action, "escalate");
  const row = (await pool.query("SELECT escalation_reason FROM execution_reconciliations WHERE client_order_id='RV0003'")).rows[0];
  assert.equal(row.escalation_reason, "ABSENCE_NOT_TRUSTWORTHY");
});

test("窗口内查不到订单则判为从未下单，可安全重试", async () => {
  await enqueueReconciliation(pool, baseInput({ clientOrderId: "RV0004", symbol: "ADA/USDT" }));
  const result = await processNextReconciliation(pool, deps({ async getOrderByClientOrderId() { return null; } }));
  assert.equal(result.action, "resolve");
  const row = (await pool.query("SELECT resolved_outcome, rejection_reason FROM execution_reconciliations WHERE client_order_id='RV0004'")).rows[0];
  assert.equal(row.resolved_outcome, "rejected");
  assert.equal(row.rejection_reason, "ORDER_NEVER_PLACED");
});

test("适配器缺失不得被当成订单不存在", async () => {
  // 因为我们这边少了个适配器就判定客户的单没下成，会导致重复下单。
  await enqueueReconciliation(pool, baseInput({ clientOrderId: "RV0005", exchange: "unknown", symbol: "DOT/USDT" }));
  const result = await processNextReconciliation(pool, { ...deps(), adapterFor: () => null });
  assert.equal(result.action, "retry");
  const row = (await pool.query("SELECT status FROM execution_reconciliations WHERE client_order_id='RV0005'")).rows[0];
  assert.equal(row.status, "pending");
});

test("租约让并发的两个 Worker 不会取到同一条", async () => {
  // 到期时间必须用测试自己的时钟，不能用数据库的 now()。
  // 用 now() 会让这条测试依赖「真实时间还没走到假时钟前面」——跨过一次午夜就失败，
  // 而失败原因看起来像并发问题。这正是 enqueueReconciliation 当初要求显式传入时刻
  // 的同一个理由：判定与记录必须用同一个时钟。
  await pool.query(
    "UPDATE execution_reconciliations SET next_attempt_at = $1 WHERE client_order_id = 'RV0005'",
    [now().toISOString()],
  );
  const slow = {
    ...deps({ async getOrderByClientOrderId() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { externalOrderId: "ex", state: "filled", filledQuantity: 1, averagePrice: 100, feeAmount: 0 };
    } }),
    adapterFor: () => ({
      exchange: "unknown",
      async placeMarketOrder() { throw new Error("unused"); },
      async getOrderByClientOrderId() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { externalOrderId: "ex", state: "filled", filledQuantity: 1, averagePrice: 100, feeAmount: 0 };
      },
    }),
  };
  const [a, b] = await Promise.all([
    processNextReconciliation(pool, { ...slow, workerId: "w1" }),
    processNextReconciliation(pool, { ...slow, workerId: "w2" }),
  ]);
  assert.equal([a, b].filter((r) => r.processed).length, 1, "只能有一个 Worker 拿到这条");
});

test("结案时手续费落库——对账推翻回执时它是费用的唯一来源", async () => {
  // 回执停在 rejected（费用 0），而这单其实成交了并且收了费。
  // 缺了这个字段只能按 0 记账：费用记少 → 净利记多 → 高水位线绩效分成多收（INV-5）。
  // 前面的用例会留下未结案的记录，租约按到期时间取，可能取到它们而不是这一条。
  await pool.query("DELETE FROM execution_reconciliations");
  await pool.query(`
    INSERT INTO execution_reconciliations
      (id, client_order_id, account_id, customer_id, exchange, symbol, requested_quantity,
       first_seen_at, next_attempt_at)
    VALUES ('r-fee','RV-FEE','acct-1','cust-1','binance','BTCUSDT',1,$1,$1)
  `, [now().toISOString()]);
  // 到期时间用测试时钟，不用数据库的 now()：这个用例的 Worker 走的是冻结时钟，
  // 两个时钟一混，租约会取不到刚插进去的这条（本仓库踩过不止一次）。
  const result = await processNextReconciliation(pool, deps({
    async getOrderByClientOrderId() {
      return { externalOrderId: "ex-fee", state: "filled", filledQuantity: 1, averagePrice: 60000, feeAmount: 42.5 };
    },
  }));
  assert.equal(result.action, "resolve");
  const row = (await pool.query(
    "SELECT status, fee_amount FROM execution_reconciliations WHERE client_order_id='RV-FEE'")).rows[0];
  assert.equal(row.status, "resolved");
  assert.equal(Number(row.fee_amount), 42.5, "适配器一直返回它，此前在 Worker 里被丢掉");
});

test("结案记录必须带手续费，数据库拒绝留空", async () => {
  // 留空与「费用确实是 0」无法区分，而两者在分成上差一笔钱。
  await pool.query(`
    INSERT INTO execution_reconciliations
      (id, client_order_id, account_id, customer_id, exchange, symbol, requested_quantity)
    VALUES ('r-nofee','RV-NOFEE','acct-1','cust-1','binance','BTCUSDT',1)
  `);
  await assert.rejects(
    () => pool.query(`
      UPDATE execution_reconciliations
      SET status='resolved', resolved_outcome='filled', filled_quantity=1, average_price=60000,
          resolved_at=now()
      WHERE id='r-nofee'`),
    /resolved_has_fee/,
  );
});
