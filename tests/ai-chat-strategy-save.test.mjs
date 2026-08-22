import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { strategyDraftFromAiMessage } from "../lib/ai-strategy-save.ts";

const validDsl = {
  schemaVersion: 1,
  name: "BTC 稳健趋势",
  symbol: "BTCUSDT",
  timeframe: "1h",
  side: "long_only",
  entry: {
    all: [
      { type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" },
      { type: "volume_ratio", period: 20, operator: "gte", value: 1.2 },
    ],
  },
  exit: {
    any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }],
    stopLossPct: 2,
    takeProfitPct: 4,
  },
  risk: {
    positionPct: 3,
    maxDrawdownPct: 8,
    dailyLossLimitPct: 2,
    consecutiveLossLimit: 3,
  },
};

test("turns a validated strategy DSL reply into a private strategy draft", () => {
  const result = strategyDraftFromAiMessage(
    `**结论**\n候选策略已生成。\n\n**JSON DSL 草稿**\n\`\`\`json\n${JSON.stringify(validDsl)}\n\`\`\``,
  );

  assert.equal(result.name, "BTC 稳健趋势");
  assert.equal(result.riskLevel, "low");
  assert.equal(result.publicationMode, "self_use");
  assert.equal(result.specification.symbol, "BTCUSDT");
  assert.match(result.summary, /止损 2%/);
});

test("rejects a reply that does not contain a valid strategy DSL", () => {
  assert.throws(
    () => strategyDraftFromAiMessage("我建议先确认交易周期。"),
    /JSON|策略/,
  );
});

test("converts an extended provider DSL into the platform backtest schema with warnings", () => {
  const result = strategyDraftFromAiMessage(`\`\`\`json
  {
    "schemaVersion":"1.0",
    "name":"BTC 扩展趋势",
    "symbol":"BTCUSDT",
    "timeframe":"1h",
    "capitalManagement":{"positionPct":3,"maxDrawdownPct":10,"dailyLossLimitPct":2,"pauseAfterConsecutiveLosses":{"lossCount":3}},
    "indicators":[{"id":"ema20","type":"EMA"},{"id":"ema60","type":"EMA"},{"id":"adx14","type":"ADX"},{"id":"atr14","type":"ATR"}],
    "entry":{"when":{"all":[{"crossesAbove":["ema20","ema60"]},{"gte":["adx14",22]},{"gt":["volume","volSma20"]}]}},
    "exit":{"any":[{"when":{"crossesBelow":["ema20","ema60"]}},{"when":{"stopLossPct":2}},{"when":{"takeProfitPct":4}},{"trailBy":{"indicator":"atr14","multiple":2}}]}
  }
  \`\`\``);

  assert.equal(result.specification.schemaVersion, 1);
  assert.equal(result.specification.entry.all[0].type, "ema_cross");
  assert.equal(result.specification.entry.all[1].type, "volume_ratio");
  assert.equal(result.specification.exit.stopLossPct, 2);
  assert.equal(result.specification.exit.takeProfitPct, 4);
  assert.match(result.conversionWarnings.join(" "), /ADX/);
  assert.match(result.conversionWarnings.join(" "), /ATR/);
});

test("converts the provider's simplified conditions draft into the platform backtest schema", () => {
  const result = strategyDraftFromAiMessage(`\`\`\`json
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

  assert.equal(result.specification.schemaVersion, 1);
  assert.equal(result.specification.side, "long_only");
  assert.deepEqual(result.specification.entry.all, [
    { type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" },
    { type: "volume_ratio", period: 20, operator: "gte", value: 1 },
  ]);
  assert.deepEqual(result.specification.exit.any, [
    { type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" },
  ]);
  assert.equal(result.specification.exit.stopLossPct, 2);
  assert.equal(result.specification.exit.takeProfitPct, 4);
});

test("does not invent a symbol or timeframe when an extended provider DSL omits them", () => {
  assert.throws(
    () => strategyDraftFromAiMessage(`\`\`\`json\n{"schemaVersion":"1.0","name":"缺字段策略","entry":{"when":{"all":[{"crossesAbove":["ema20","ema60"]}]}},"exit":{"any":[]},"capitalManagement":{"positionPct":3,"maxDrawdownPct":10}}\n\`\`\``),
    /交易对|周期/,
  );
});

test("does not silently turn a provider short strategy into a long-only draft", () => {
  assert.throws(
    () => strategyDraftFromAiMessage(`\`\`\`json\n{"name":"BTC short","symbol":"BTCUSDT","timeframe":"1h","side":"short","entry":{"conditions":[{"type":"ema_cross","fastPeriod":20,"slowPeriod":60,"cross":"below"}]},"exit":{"conditions":[]},"risk":{"positionPct":3}}\n\`\`\``),
    /仅支持仅做多/,
  );
});

test("agent chat exposes message-level strategy saving and model-only attribution", async () => {
  const [chat, content, conversationRoute, persistence, saveRoute] = await Promise.all([
    readFile(new URL("../apps/client/ui/ai-assistant-chat.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/client/ui/ai-message-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai/conversations/[id]/route.client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-conversations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai/conversations/[id]/messages/[messageId]/strategy/route.client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(content, /保存到我的策略/);
  assert.match(chat, /messages\/\$\{encodeURIComponent\(messageId\)\}\/strategy/);
  assert.match(chat, /message\.model/);
  assert.doesNotMatch(chat, /message\.providerName/);
  assert.match(conversationRoute, /model: message\.model/);
  assert.match(conversationRoute, /savedStrategyId: savedStrategyIds\.get\(message\.id\)/);
  assert.doesNotMatch(conversationRoute, /providerName: message\.providerName/);
  assert.match(persistence, /model: row\.model/);
  assert.match(persistence, /getSavedStrategyIdsForAiMessages/);
  assert.match(saveRoute, /strategyDraftFromAiMessage/);
  assert.match(saveRoute, /INVALID_RESOURCE_ID/);
  assert.match(saveRoute, /publicationMode: draft\.publicationMode/);
});

test("agent chat renders generation progress as a new assistant reply, not button text", async () => {
  const [chat, styles] = await Promise.all([
    readFile(new URL("../apps/client/ui/ai-assistant-chat.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(chat, /agent-chat-generating-dots/);
  assert.match(chat, /正在生成回复/);
  assert.match(chat, />发送问题 →<\/button>/);
  assert.doesNotMatch(chat, /\{sending \? "生成中…" : "发送问题 →"\}/);
  assert.match(styles, /\.agent-chat-generating-dots/);
  assert.match(styles, /@keyframes ai-generating-dot/);
});

test("assistant prompt gives the provider the exact canonical strategy DSL contract", async () => {
  const assistant = await readFile(new URL("../lib/ai-assistant.ts", import.meta.url), "utf8");

  assert.match(assistant, /schemaVersion.*必须为 1/s);
  assert.match(assistant, /entry\.all/);
  assert.match(assistant, /exit\.any/);
  assert.match(assistant, /side.*long_only/s);
  assert.match(assistant, /不要输出.*conditions/s);
});
