import assert from "node:assert/strict";
import test from "node:test";

import { parseAiMessage } from "../lib/ai-message-presentation.ts";

test("parses professional AI replies into ordered semantic sections without Markdown noise", () => {
  const result = parseAiMessage(`**结论**\nBTC 1h 结构偏强，但不应追价。\n\n**关键证据**\n- EMA20 高于 EMA60\n- RSI14 为 69\n\n**失效条件**\n- 跌破 63295 支撑\n\n**下一步**\n等待收盘确认。`);

  assert.deepEqual(result.sections.map((section) => section.kind), [
    "conclusion",
    "evidence",
    "invalidations",
    "next_step",
  ]);
  assert.equal(result.sections[0].paragraphs[0], "BTC 1h 结构偏强，但不应追价。");
  assert.deepEqual(result.sections[1].items, ["EMA20 高于 EMA60", "RSI14 为 69"]);
  assert.equal(result.sections[2].items[0], "跌破 63295 支撑");
  assert.equal(result.sections.flatMap((section) => section.paragraphs).join(" ").includes("**"), false);
});

test("preserves unstructured historical replies as readable body content", () => {
  const result = parseAiMessage("当前数据不足，请补充交易对和周期。");

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].kind, "body");
  assert.deepEqual(result.sections[0].paragraphs, ["当前数据不足，请补充交易对和周期。"]);
});

test("keeps fenced strategy JSON in a dedicated code block instead of flattening it", () => {
  const result = parseAiMessage(`**结论**\n已生成草稿。\n\n**JSON DSL 草稿**\n\`\`\`json\n{"schemaVersion":1}\n\`\`\``);
  const dsl = result.sections.find((section) => section.kind === "strategy_dsl");

  assert.ok(dsl);
  assert.equal(dsl.codeBlocks[0].language, "json");
  assert.equal(dsl.codeBlocks[0].code, '{"schemaVersion":1}');
});
