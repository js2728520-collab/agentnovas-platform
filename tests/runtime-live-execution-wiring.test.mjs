import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 实盘下发只允许出现在现货路径上。
//
// 这条测试的由来是一个真实的失误：批量替换时把整段下发逻辑同时插进了永续路径，
// 而永续路由是硬关闭的（AGENTS.md）。tsc 没有意见，只有 lint 因为变量未使用报了
// 两条警告才暴露出来——如果那两个变量恰好被用上，它会静默留在那里。
//
// 所以这里守住三件可机器检查的事，而不是靠人记得。

const source = await readFile(new URL("../lib/strategy-runtime-worker.ts", import.meta.url), "utf8");

test("executeOrderIntent 在 Worker 里只有一个调用点", () => {
  const callSites = source.match(/await executeOrderIntent\(/g) ?? [];
  assert.equal(callSites.length, 1, `期望 1 个调用点，实际 ${callSites.length} 个`);
});

test("下发被 lease.mode === \"live\" 守住", () => {
  // 用位置关系而不是固定窗口的正则：守卫与调用之间隔着整段翻译逻辑，
  // 写死字符距离的断言会在无关改动时假红。
  const guard = source.indexOf('lease.mode === "live"');
  const call = source.indexOf("await executeOrderIntent(");
  assert.ok(guard >= 0, "找不到 live 模式守卫");
  assert.ok(call > guard, "下发必须在 live 模式守卫之后");
});

test("下发要求已绑定交易所账户", () => {
  // 没有账户就无法下单。数据库的 binding check 也挡这一条，这里是第二层。
  assert.match(source, /lease\.mode === "live"[^\n]*lease\.exchangeAccountId/);
});

test("永续守卫仍然在册，没有被「开实盘」顺手删掉", async () => {
  const guard = await readFile(new URL("../lib/beta-legacy-runtime-guard.ts", import.meta.url), "utf8");
  assert.match(guard, /executionProduct !== "spot_usdt"/);
  assert.match(source, /assertBetaSpotRuntimeLease\(lease\.executionProduct\)/);
});

test("下发的执行标的写死为现货", () => {
  assert.match(source, /executionProduct: "spot_usdt"/);
  assert.ok(!/executionProduct: "usdt_perpetual"/.test(source), "Worker 不得下发永续");
});
