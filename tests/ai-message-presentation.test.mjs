import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAiQuestionAnswers,
  hasStrategyDslCodeBlock,
  parseAiMessage,
} from "../lib/ai-message-presentation.ts";

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

test("detects a strategy DSL code block even when the provider uses a custom heading", () => {
  const result = parseAiMessage(`**关键证据**\n## 可保存、可回测的策略DSL（草稿最终版）\n\`\`\`json\n{"schemaVersion":"1.0","name":"BTC 趋势","symbol":"BTCUSDT","timeframe":"1h","entry":{"when":{"all":[]}},"exit":{"any":[]},"capitalManagement":{"positionPct":3,"maxDrawdownPct":10}}\n\`\`\``);

  assert.equal(result.sections[0].kind, "evidence");
  assert.equal(hasStrategyDslCodeBlock(result), true);
});

test("detects a provider strategy draft that omits schemaVersion but contains convertible rules", () => {
  const result = parseAiMessage(`**JSON DSL 草稿**\n\`\`\`json
  {
    "name":"BTCUSDT_1h_EMA20x60_Volume_LowRisk",
    "symbol":"BTCUSDT",
    "timeframe":"1h",
    "side":"long",
    "entry":{"operator":"AND","conditions":[{"type":"ema_cross","fastPeriod":20,"slowPeriod":60,"cross":"above"},{"type":"volume_ratio","period":20,"operator":">=","value":1}]},
    "exit":{"operator":"OR","conditions":[{"type":"ema_cross","fastPeriod":20,"slowPeriod":60,"cross":"below"}]},
    "risk":{"positionPct":3,"maxDrawdownPct":10,"dailyLossLimitPct":2,"stopLossPct":2,"takeProfitPct":4},
    "enabled":false
  }
  \`\`\``);

  assert.equal(hasStrategyDslCodeBlock(result), true);
});

test("does not expose saving for a provider draft that requests a short strategy", () => {
  const result = parseAiMessage(`\`\`\`json
  {"name":"BTC short","symbol":"BTCUSDT","timeframe":"1h","side":"short","entry":{"conditions":[{"type":"ema_cross","fastPeriod":20,"slowPeriod":60,"cross":"below"}]},"exit":{"conditions":[]},"risk":{"positionPct":3}}
  \`\`\``);

  assert.equal(hasStrategyDslCodeBlock(result), false);
});

test("extracts explicit candidates and selects the recommended first option by default", () => {
  const result = parseAiMessage(`**待确认问题**\n1. 固定止损和 ATR 止损哪个优先？\n候选：两者并行，先触发者优先（推荐） | 固定止损优先 | ATR 止损优先`);

  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].prompt, "固定止损和 ATR 止损哪个优先？");
  assert.deepEqual(result.questions[0].options, [
    "两者并行，先触发者优先（推荐）",
    "固定止损优先",
    "ATR 止损优先",
  ]);
  assert.equal(result.questions[0].defaultOption, "两者并行，先触发者优先（推荐）");
  assert.equal(result.sections.flatMap((section) => section.paragraphs).some((text) => text.startsWith("候选：")), false);
});

test("provides useful fallback candidates for historical numbered questions", () => {
  const result = parseAiMessage(`**下一步**\n请确认：\n1. 固定止损 2% 与 2倍ATR移动止损同时存在时，哪个优先执行？\n2. 是否允许同向重复开仓，还是持仓期间禁止再次开仓？`);

  assert.equal(result.questions.length, 2);
  assert.match(result.questions[0].defaultOption, /先触发者优先/);
  assert.match(result.questions[1].defaultOption, /禁止重复开仓/);
  assert.equal(result.questions.every((question) => question.options.length >= 3), true);
});

test("does not create a confirmation prompt for explanatory replies without a question", () => {
  assert.deepEqual(parseAiMessage("**下一步**\n等待下一根K线收盘。").questions, []);
});

test("formats confirmed choices as a normal persisted customer message", () => {
  const content = formatAiQuestionAnswers([
    { prompt: "止损优先级？", answer: "两者并行，先触发者优先（推荐）" },
    { prompt: "是否允许重复开仓？", answer: "持仓期间禁止重复开仓" },
  ]);

  assert.equal(content, "关于你提出的待确认问题，我的选择是：\n1. 止损优先级？\n   回答：两者并行，先触发者优先\n2. 是否允许重复开仓？\n   回答：持仓期间禁止重复开仓");
});
