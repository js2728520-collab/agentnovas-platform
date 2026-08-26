import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_ORDER_ID_MAX_LENGTH,
  CLIENT_ORDER_ID_PATTERN,
  deriveClientOrderId,
} from "../packages/domain/src/execution/client-order-id.ts";
import {
  newTokenBucket,
  planTokenBucketDispatch,
  planTwoLevelDispatch,
  refillTokenBucket,
} from "../packages/domain/src/execution/rate-limit.ts";
import { classifyFill, unfilledRemainder } from "../packages/domain/src/execution/fill-accounting.ts";

const ROUND = { decisionRoundId: "round-1", portfolioId: "pf-1", action: "entry" };

// --- 幂等下单标识 ---------------------------------------------------------

test("相同输入永远派生出同一个 clientOrderId", async () => {
  const first = await deriveClientOrderId(ROUND);
  const second = await deriveClientOrderId({ ...ROUND });
  assert.equal(first, second);
});

test("clientOrderId 满足三家交易所的字符集与长度交集", async () => {
  const id = await deriveClientOrderId(ROUND);
  assert.ok(CLIENT_ORDER_ID_PATTERN.test(id), `不合法的 id: ${id}`);
  assert.equal(id.length, CLIENT_ORDER_ID_MAX_LENGTH);
  assert.ok(id.startsWith("RV"));
});

test("同轮同组合的不同动作必须是不同的 id", async () => {
  // 否则平仓会被交易所当成开仓的重复请求直接拒掉——客户想离场却离不了。
  const entry = await deriveClientOrderId({ ...ROUND, action: "entry" });
  const exit = await deriveClientOrderId({ ...ROUND, action: "exit" });
  assert.notEqual(entry, exit);
});

test("不同组合、不同决策轮各自独立", async () => {
  const base = await deriveClientOrderId(ROUND);
  assert.notEqual(base, await deriveClientOrderId({ ...ROUND, portfolioId: "pf-2" }));
  assert.notEqual(base, await deriveClientOrderId({ ...ROUND, decisionRoundId: "round-2" }));
});

test("缺字段直接抛，不允许两笔不同的单共用一个 id", async () => {
  for (const field of ["decisionRoundId", "portfolioId", "action"]) {
    await assert.rejects(
      () => deriveClientOrderId({ ...ROUND, [field]: "  " }),
      /CLIENT_ORDER_ID_INPUT_INVALID/,
    );
  }
});

test("1000 个组合在同一轮里不产生碰撞", async () => {
  const ids = await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      deriveClientOrderId({ ...ROUND, portfolioId: `pf-${index}` })),
  );
  assert.equal(new Set(ids).size, 1000);
});

// --- 限流 -----------------------------------------------------------------

const CONFIG = { capacity: 10, refillPerSecond: 5 };

test("桶里有令牌时立即发出", () => {
  const bucket = newTokenBucket(CONFIG, 1_000);
  const plan = planTokenBucketDispatch(bucket, CONFIG, 1_000);
  assert.equal(plan.startAtMs, 1_000);
  assert.equal(plan.nextState.tokens, 9);
});

test("令牌耗尽时排队而不是拒绝", () => {
  // ADR-0019：丢弃等于客户没跟上这一轮，而他并不知道。
  let state = newTokenBucket(CONFIG, 0);
  for (let index = 0; index < 10; index += 1) {
    state = planTokenBucketDispatch(state, CONFIG, 0).nextState;
  }
  const plan = planTokenBucketDispatch(state, CONFIG, 0);
  assert.ok(plan.startAtMs > 0, "第 11 笔应被排到未来而不是被拒");
  assert.equal(plan.startAtMs, 200); // 1 个令牌 / 5 每秒 = 200ms
});

test("时间倒流不会凭空造出令牌，也不会把桶的时间线拨回去", () => {
  // NTP 回拨或传错的 now 不该变成限流失效。
  const drained = { tokens: 0, updatedAtMs: 10_000 };
  const refilled = refillTokenBucket(drained, CONFIG, 5_000);
  assert.equal(refilled.tokens, 0);
  assert.equal(refilled.updatedAtMs, 10_000, "桶的时间线只能前进");
});

test("在同一个 now 上连续规划时排队时间必须累积", () => {
  // 扇出就是这个形状：一轮决策在同一个 now 上一次性规划上千笔。
  // 若每笔都从调用方的 now 起算，所有排队会被压缩到前面，限流形同虚设。
  const config = { capacity: 1, refillPerSecond: 1 };
  let state = newTokenBucket(config, 0);
  const starts = [];
  for (let index = 0; index < 5; index += 1) {
    const plan = planTokenBucketDispatch(state, config, 0);
    starts.push(plan.startAtMs);
    state = plan.nextState;
  }
  assert.deepEqual(starts, [0, 1000, 2000, 3000, 4000]);
});

test("补充有上限，长时间空闲不会攒出无限突发", () => {
  const refilled = refillTokenBucket({ tokens: 0, updatedAtMs: 0 }, CONFIG, 10_000_000);
  assert.equal(refilled.tokens, CONFIG.capacity);
});

test("配置非法直接抛，不静默变成无限等待", () => {
  const bucket = newTokenBucket(CONFIG, 0);
  assert.throws(() => planTokenBucketDispatch(bucket, { capacity: 10, refillPerSecond: 0 }, 0),
    /RATE_LIMIT_CONFIG_INVALID/);
  assert.throws(() => planTokenBucketDispatch(bucket, { capacity: 0, refillPerSecond: 5 }, 0),
    /RATE_LIMIT_CONFIG_INVALID/);
});

test("单笔开销超过桶容量直接抛，不会永远等下去", () => {
  const bucket = newTokenBucket(CONFIG, 0);
  assert.throws(() => planTokenBucketDispatch(bucket, CONFIG, 0, 11), /RATE_LIMIT_COST_EXCEEDS_CAPACITY/);
});

test("两级限流取较严格的一级", () => {
  const config = {
    account: { capacity: 100, refillPerSecond: 100 },
    global: { capacity: 2, refillPerSecond: 1 },
  };
  let state = { account: newTokenBucket(config.account, 0), global: newTokenBucket(config.global, 0) };
  const starts = [];
  for (let index = 0; index < 4; index += 1) {
    const plan = planTwoLevelDispatch(state, config, 0);
    starts.push(plan.startAtMs);
    state = plan.nextState;
  }
  // 全局桶容量 2、每秒补 1：前两笔立刻，之后每秒一笔。
  assert.deepEqual(starts, [0, 0, 1000, 2000]);
});

test("需要等待时两级在同一时刻扣费", () => {
  // 各扣各的会让全局桶按一个比真实发出更早的时刻记账，于是它以为还有余量，
  // 实际已经超发——限流恰好在高并发时失效。
  const config = {
    account: { capacity: 1, refillPerSecond: 1 },
    global: { capacity: 100, refillPerSecond: 100 },
  };
  let state = { account: newTokenBucket(config.account, 0), global: newTokenBucket(config.global, 0) };
  state = planTwoLevelDispatch(state, config, 0).nextState;
  const plan = planTwoLevelDispatch(state, config, 0);
  assert.equal(plan.startAtMs, 1000, "账户级需要等 1 秒");
  assert.equal(plan.nextState.global.updatedAtMs, 1000, "全局桶必须记在实际发出的时刻");
  assert.equal(plan.nextState.account.updatedAtMs, 1000);
});

// --- 成交回执 -------------------------------------------------------------

test("部分成交必须记成 partial，不得向上取整", () => {
  const result = classifyFill({ requestedQuantity: 1, filledQuantity: 0.7, averagePrice: 100, state: "partially_filled" });
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledQuantity, 0.7);
});

test("差一点点也是 partial —— 默认零容差", () => {
  // 把 0.999999 记成 1 会让止损时去卖一个不存在的 0.000001，
  // 也会让绩效按客户从未持有的仓位计费。
  const result = classifyFill({ requestedQuantity: 1, filledQuantity: 0.999999, averagePrice: 100, state: "filled" });
  assert.equal(result.outcome, "partial");
});

test("显式传容差才允许把步进造成的缺口判为 filled", () => {
  const result = classifyFill({
    requestedQuantity: 1, filledQuantity: 0.999999, averagePrice: 100, state: "filled",
    quantityTolerance: 0.00001,
  });
  assert.equal(result.outcome, "filled");
  assert.equal(result.filledQuantity, 0.999999, "判为 filled 也要如实记录实际成交量");
});

test("零成交必须带上可区分的原因", () => {
  const cases = [["rejected", "EXCHANGE_REJECTED"], ["canceled", "EXCHANGE_CANCELED"], ["live", "NOT_FILLED_YET"]];
  for (const [state, reason] of cases) {
    const result = classifyFill({ requestedQuantity: 1, filledQuantity: 0, averagePrice: 0, state });
    assert.equal(result.outcome, "rejected");
    assert.equal(result.rejectionReason, reason);
  }
});

test("有成交却没有均价必须抛，不能补默认价", () => {
  assert.throws(() => classifyFill({ requestedQuantity: 1, filledQuantity: 0.5, averagePrice: 0, state: "partially_filled" }),
    /FILL_AVERAGE_PRICE_INVALID/);
  assert.throws(() => classifyFill({ requestedQuantity: 1, filledQuantity: 0.5, averagePrice: Number.NaN, state: "partially_filled" }),
    /FILL_AVERAGE_PRICE_INVALID/);
});

test("超额成交如实记录并判为 filled", () => {
  const result = classifyFill({ requestedQuantity: 1, filledQuantity: 1.02, averagePrice: 100, state: "filled" });
  assert.equal(result.outcome, "filled");
  assert.equal(result.filledQuantity, 1.02);
});

test("剩余未成交量供对账使用", () => {
  assert.equal(unfilledRemainder({ requestedQuantity: 1, filledQuantity: 0.7 }), 0.3);
  assert.equal(unfilledRemainder({ requestedQuantity: 1, filledQuantity: 1.2 }), 0);
});
