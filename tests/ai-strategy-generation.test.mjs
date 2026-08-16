import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractStrategyDslFromText,
  normalizeStrategyBrief,
  strategyDslExplanation,
} from "../lib/ai-strategy-generation.ts";

const providerDsl = {
  schemaVersion: 1,
  name: "BTC 趋势策略",
  symbol: "BTCUSDT",
  timeframe: "1h",
  side: "long_only",
  entry: {
    all: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" }],
  },
  exit: {
    any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }],
    stopLossPct: 2,
    takeProfitPct: 4,
  },
  risk: {
    positionPct: 3,
    maxDrawdownPct: 10,
    dailyLossLimitPct: 2,
    consecutiveLossLimit: 3,
  },
};

test("extracts and validates the first JSON object from a provider response", () => {
  const parsed = extractStrategyDslFromText(`候选规则如下：\n\`\`\`json\n${JSON.stringify(providerDsl)}\n\`\`\``);
  assert.equal(parsed.symbol, "BTCUSDT");
  assert.equal(parsed.entry.all[0].type, "ema_cross");

  assert.throws(
    () => extractStrategyDslFromText(JSON.stringify({ ...providerDsl, code: "buy()" })),
    /不支持的字段/,
  );
});

test("normalizes a bounded strategy brief and rejects secrets", () => {
  const brief = normalizeStrategyBrief({
    name: "  BTC 保守趋势  ",
    symbol: "BTC/USDT",
    period: "1h",
    style: "趋势跟随",
    capital: "3",
    stopLoss: "2",
    takeProfit: "4",
    maxDrawdown: "10",
    entryRule: "EMA 金叉",
  });
  assert.equal(brief.name, "BTC 保守趋势");
  assert.equal(brief.symbol, "BTC/USDT");
  assert.throws(
    () => normalizeStrategyBrief({ ...brief, riskRule: "api_key = sk-proj-abcdefghijklmnopqrstuv" }),
    /敏感信息/,
  );
});

test("produces a deterministic explanation without a return promise", () => {
  const explanation = strategyDslExplanation(providerDsl);
  assert.match(explanation, /EMA20\/60/);
  assert.match(explanation, /仓位 3%/);
  assert.doesNotMatch(explanation, /保证|稳赚|预期收益/);
});

test("strategy generation route reads owned server history and validates provider output", async () => {
  const source = await readFile(new URL("../app/api/strategy-studio/generate/route.ts", import.meta.url), "utf8");
  assert.match(source, /getOwnedAiConversation/);
  assert.match(source, /getConversationMessages/);
  assert.match(source, /generateStrategyProposal/);
  assert.match(source, /generationId/);
  assert.doesNotMatch(source, /body\.(conversation|history|messages)\b/);
});
