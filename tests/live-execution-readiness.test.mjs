import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LIVE_EXECUTION_BLOCKERS,
  describeLiveExecutionBlockers,
  isLiveExecutionReady,
} from "../packages/domain/src/execution/live-readiness.ts";

// 这个测试守住的不是「实盘关着」，而是「关着这件事是被明确表达的」。
//
// 危险从来不是现在发不出单——那是安全的。危险在于逐处拆掉阻断，每一步都像修 bug，
// 全部拆完之后打开的是一条还不安全的真实交易通道。

test("实盘未就绪，且清单非空", () => {
  assert.equal(isLiveExecutionReady(), false);
  assert.ok(LIVE_EXECUTION_BLOCKERS.length > 0);
});

test("清单里每条都有 code 和可读的原因", () => {
  for (const blocker of LIVE_EXECUTION_BLOCKERS) {
    assert.match(blocker.code, /^[A-Z_]+$/);
    assert.ok(blocker.detail.length > 20, `${blocker.code} 的说明太短，看的人不知道要做什么`);
  }
  assert.ok(describeLiveExecutionBlockers().includes(LIVE_EXECUTION_BLOCKERS[0].code));
});

test("已经解决的记账缺口不得再出现在清单里", () => {
  // 这四条曾经是清单的主体：它们不阻止下单，而是让下单之后的一切都是错的。
  // 现在各自有了实现与测试，留在清单里会让「还差什么」这个问题重新失去答案。
  const codes = new Set(LIVE_EXECUTION_BLOCKERS.map((blocker) => blocker.code));
  for (const resolved of [
    "LIVE_POSITION_TRACKING_MISSING",
    "LIVE_FILLS_NOT_IN_RISK_STATE",
    "LIVE_FILLS_NOT_IN_FEE_BASIS",
    "RECONCILED_RESULT_NOT_IN_RECEIPT",
    "OKX_HAS_NO_LIVE_ADAPTER",
  ]) {
    assert.ok(!codes.has(resolved), `${resolved} 已经解决，不该还在清单里`);
  }
});

test("对账未决时不会记账——记账缺口确实被堵上了", async () => {
  // 上一条只检查清单文本。这一条检查那些缺口对应的代码真的存在，
  // 否则「从清单里删掉」就只是把问题藏起来。
  const posting = await readFile(new URL("../lib/live-book-posting.ts", import.meta.url), "utf8");
  assert.match(posting, /resolveEffectiveFill/, "记账必须以事实判定为输入，而不是下单响应");
  assert.match(posting, /live_book_postings/, "必须有防重复记账的登记");
  assert.match(posting, /refreshOfficialPaperRiskState/, "记账后必须刷新风控读数");
});

test("剩下的阻塞是真的还没做，不是措辞变了", async () => {
  const codes = new Set(LIVE_EXECUTION_BLOCKERS.map((blocker) => blocker.code));
  // 余额核对：没有任何代码去拉交易所余额与账本比对。
  assert.ok(codes.has("EXCHANGE_BALANCE_NOT_RECONCILED"));
  // 开通入口：判定写好了，但没有客户侧调用方。
  assert.ok(codes.has("LIVE_ACTIVATION_ENTRY_MISSING"));
  const activation = await readFile(
    new URL("../packages/domain/src/execution/live-activation.ts", import.meta.url), "utf8");
  assert.match(activation, /checkLiveActivation/);
});

test("Worker 在下发之前检查就绪状态", async () => {
  const worker = await readFile(new URL("../lib/strategy-runtime-worker.ts", import.meta.url), "utf8");
  const gate = worker.indexOf("isLiveExecutionReady()");
  const dispatch = worker.indexOf("await executeOrderIntent(");
  assert.ok(gate > 0, "Worker 必须检查实盘就绪状态");
  assert.ok(gate < dispatch, "就绪检查必须排在下发之前");
});

test("清单清空后 isLiveExecutionReady 会自然变真", () => {
  // 它不是一个可以直接翻的开关：清单里每条都必须先有实现和测试。
  assert.equal(isLiveExecutionReady(), LIVE_EXECUTION_BLOCKERS.length === 0);
});
