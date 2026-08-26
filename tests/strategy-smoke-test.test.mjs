import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  describeStrategySmokeVerdict,
  evaluateStrategySmokeTest,
  MINIMUM_SMOKE_SIGNALS,
} from "../packages/domain/src/strategy-smoke-test.ts";

// 保存前的冒烟回测。
//
// 「策略能正常运行」的定义不是「DSL 合法」，而是「跑得完且真的会触发信号」。
// 静态校验挡不住「指标周期比 K 线还长」「条件永远不成立」——它们会让保存看起来
// 成功，等客户部署后才发现什么都没发生。

const result = (patch) => ({ sampleSize: 5, liquidated: false, candleCount: 300, ...patch });

test("跑完且有信号即通过，不看收益", () => {
  // 亏钱的策略照样通过——判定只回答「能不能跑」。
  const verdict = evaluateStrategySmokeTest(result({ sampleSize: MINIMUM_SMOKE_SIGNALS }));
  assert.equal(verdict.status, "passed");
  assert.equal(verdict.signals, MINIMUM_SMOKE_SIGNALS);
});

test("零信号判为不通过，并说明条件可能永远不成立", () => {
  const verdict = evaluateStrategySmokeTest(result({ sampleSize: 0 }));
  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason, /从未触发交易信号/);
  assert.match(verdict.reason, /300/, "应说明是在多少根 K 线上");
});

test("触发强平判为不通过", () => {
  const verdict = evaluateStrategySmokeTest(result({ liquidated: true }));
  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason, /强平/);
});

test("异常的 sampleSize 按 0 处理而不是崩溃", () => {
  for (const sampleSize of [-1, 1.5, Number.NaN]) {
    const verdict = evaluateStrategySmokeTest(result({ sampleSize }));
    assert.equal(verdict.status, "failed", String(sampleSize));
    assert.equal(verdict.signals, 0);
  }
});

test("「未执行」的措辞不能看起来像「已通过」", () => {
  // INV-6：未达门槛必须显式标注。行情取不到不是策略的错，但也不是通过。
  const text = describeStrategySmokeVerdict({ status: "skipped", reason: "历史行情不可用" });
  assert.match(text, /未执行/);
  assert.match(text, /尚未验证/);
  assert.doesNotMatch(text, /通过/);
});

test("通过的措辞必须声明与收益无关", () => {
  const text = describeStrategySmokeVerdict({ status: "passed", signals: 7 });
  assert.match(text, /不代表收益/);
});

// ---------------------------------------------------------------------------
// 无法单测的部分用源码契约断言（仓库既有做法）
// ---------------------------------------------------------------------------

test("保存端点在写库之前先跑冒烟回测，并把结论留痕", async () => {
  const route = await readFile(
    new URL("../app/api/ai/conversations/[id]/messages/[messageId]/strategy/route.client.ts", import.meta.url),
    "utf8",
  );
  const smokeAt = route.indexOf("runStrategySmokeTest");
  const createAt = route.indexOf("createStrategyDraft({");
  assert.ok(smokeAt > 0 && createAt > 0);
  assert.ok(smokeAt < createAt, "冒烟回测必须发生在写库之前");
  assert.match(route, /STRATEGY_SMOKE_TEST_FAILED/);
  assert.match(route, /describeStrategySmokeVerdict\(smoke\)/, "结论必须写进保存记录");
});

test("修复循环用的是保存时的同一道校验闸门", async () => {
  // 用别的校验会「修复」出一个仍然存不进去的东西。
  const assistant = await readFile(new URL("../lib/ai-assistant.ts", import.meta.url), "utf8");
  assert.match(assistant, /strategyDraftFromAiMessage/);
  assert.match(assistant, /STRATEGY_REPAIR_ATTEMPTS/);
  assert.match(assistant, /metering\.inputTokens \+= /, "多次调用的用量必须合并上报");
});

test("修复循环的额外调用有对应的 Credits 预留", async () => {
  // 少留就会在结算时因实耗超过预留被拒（AI_CREDIT_RESERVATION_EXCEEDED）。
  const route = await readFile(
    new URL("../app/api/ai/conversations/[id]/messages/route.client.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /STRATEGY_REPAIR_ATTEMPTS/);
  assert.match(route, /estimatedClientAiCredits\(900\)\s*\n?\s*\*\s*BigInt\(/);
});
