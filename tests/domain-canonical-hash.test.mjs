import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalJsonSha256 } from "../packages/domain/src/canonical-hash.ts";

// 规范化 JSON 哈希。
//
// 「两次请求是不是同一件事」靠它回答：决策轮幂等（INV-8）、研发步骤检查点、
// 策略 DSL 合同哈希用的都是这一个函数。它不确定，幂等就不成立。

test("对象键序不影响结果", async () => {
  const a = { beta: 1, alpha: 2, gamma: { z: 1, a: 2 } };
  const b = { gamma: { a: 2, z: 1 }, alpha: 2, beta: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(await canonicalJsonSha256(a), await canonicalJsonSha256(b));
});

test("数组顺序影响结果", async () => {
  // 键是无序集合，数组是有序序列——两者不能一视同仁。
  assert.notEqual(await canonicalJsonSha256([1, 2]), await canonicalJsonSha256([2, 1]));
});

test("undefined 属性视为不存在", async () => {
  assert.equal(
    await canonicalJsonSha256({ a: 1, b: undefined }),
    await canonicalJsonSha256({ a: 1 }),
  );
});

test("null 与缺失是两回事", async () => {
  assert.notEqual(await canonicalJsonSha256({ a: 1, b: null }), await canonicalJsonSha256({ a: 1 }));
});

test("非有限数字直接抛错，不静默转成 null", () => {
  // JSON.stringify 会把 NaN 和 Infinity 都变成 null，
  // 那会让两组不同的输入哈希相同——幂等键撞车就是重复扣费或漏执行。
  for (const value of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJson({ x: value }), /非有限数字/);
  }
});

test("不可序列化值直接抛错", () => {
  assert.throws(() => canonicalJson({ fn: () => 1 }), /不可序列化/);
  assert.throws(() => canonicalJson({ big: BigInt(1) }), /不可序列化/);
});

test("同一输入重复计算结果稳定", async () => {
  const payload = { cardId: "ai_balanced", candleId: "BTCUSDT:1h:1755840000000", nested: [1, { k: "v" }] };
  const first = await canonicalJsonSha256(payload);
  assert.equal(await canonicalJsonSha256(payload), first);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("哈希值与迁移前保持一致", async () => {
  // 这个函数此前叫 hashResearchStepInput，已有的检查点行里存着它算出的哈希。
  // 改了算法等于让所有历史检查点失效，所以钉死一个已知值。
  assert.equal(
    canonicalJson({ stage: "market_analysis", runId: "run-1" }),
    '{"runId":"run-1","stage":"market_analysis"}',
  );
  assert.equal(
    await canonicalJsonSha256({ stage: "market_analysis", runId: "run-1" }),
    "4e3b565f6c9381051a77d7adc0b037788fba39f77ec6be71e0835b1448f37f6d",
  );
});
