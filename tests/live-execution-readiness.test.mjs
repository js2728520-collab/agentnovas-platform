import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LIVE_EXECUTION_BLOCKERS,
  describeLiveExecutionBlockers,
  isLiveExecutionReady,
} from "../packages/domain/src/execution/live-readiness.ts";

// 实盘链路目前**没有接通**，而且是被五处互相独立的检查各自挡住的。
// 这个测试守住的不是「实盘关着」，而是「关着这件事是被明确表达的」。
//
// 危险不在于现在发不出单——那是安全的。危险在于逐个拆掉那五处，每一步都像修 bug，
// 全部拆完之后打开的是一条记账不成立的真实交易通道。

test("实盘未就绪，且清单非空", () => {
  assert.equal(isLiveExecutionReady(), false);
  assert.ok(LIVE_EXECUTION_BLOCKERS.length > 0);
});

test("清单里每条都有 code 和可读的原因", () => {
  for (const blocker of LIVE_EXECUTION_BLOCKERS) {
    assert.match(blocker.code, /^[A-Z_]+$/);
    assert.ok(blocker.detail.length > 20, `${blocker.code} 的说明太短，看的人不知道要做什么`);
  }
  assert.match(describeLiveExecutionBlockers(), /LIVE_POSITION_TRACKING_MISSING/);
});

test("记账缺口都在清单里——它们比「发不出单」严重", () => {
  // 这四条不阻止下单，它们让下单之后的一切都是错的。
  const codes = new Set(LIVE_EXECUTION_BLOCKERS.map((blocker) => blocker.code));
  for (const required of [
    "LIVE_POSITION_TRACKING_MISSING",
    "LIVE_FILLS_NOT_IN_RISK_STATE",
    "LIVE_FILLS_NOT_IN_FEE_BASIS",
    "RECONCILED_RESULT_NOT_IN_RECEIPT",
  ]) {
    assert.ok(codes.has(required), `清单缺少 ${required}`);
  }
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
