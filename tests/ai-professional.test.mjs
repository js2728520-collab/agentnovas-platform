import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSessionWorkingMemory,
  classifyAssistantIntent,
  guidedAssistantReply,
} from "../lib/ai-chat-protocol.ts";
import { summarizeResearchCandles } from "../lib/ai-research.ts";

test("classifies professional research workflows", () => {
  assert.equal(classifyAssistantIntent("BTC 当前走势、支撑位和阻力位怎么看？"), "market_analysis");
  assert.equal(classifyAssistantIntent("解释一下我的持仓风险"), "portfolio_risk");
  assert.equal(classifyAssistantIntent("帮我生成一个 1 小时趋势策略"), "strategy_research");
  assert.equal(classifyAssistantIntent("为什么这个策略回测后的最大回撤很大？"), "backtest_help");
  assert.equal(classifyAssistantIntent("你好"), "general");
});

test("extracts working memory and tells the assistant not to repeat known questions", () => {
  const memory = buildSessionWorkingMemory(
    [
      { role: "user", content: "我想做 BTC/USDT 的 1 小时趋势策略" },
      { role: "assistant", content: "你能接受多大的回撤？" },
    ],
    "最大回撤控制在 10%，单次仓位 3%",
  );

  assert.equal(memory.knownFields.symbol, "BTCUSDT");
  assert.equal(memory.knownFields.timeframe, "1h");
  assert.equal(memory.knownFields.maxDrawdownPct, 10);
  assert.equal(memory.knownFields.positionPct, 3);
  assert.match(memory.instruction, /不要重复询问/);
  assert.equal(memory.recentUserFacts.filter((item) => item.includes("最大回撤")).length, 1);
});

test("message route builds market context from server-owned conversation history", async () => {
  const source = await readFile(new URL("../app/api/ai/conversations/[id]/messages/route.client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /const \[history, context, config\]/);
  assert.match(source, /history\s*\.filter\(\(message\) => message\.role === "user"\)/);
  assert.match(source, /const context = await buildAssistantContext/);
});

test("summarizes deterministic candles into an auditable technical snapshot", () => {
  const baseTime = Date.UTC(2026, 0, 1);
  const candles = Array.from({ length: 80 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      openTime: baseTime + index * 60 * 60 * 1_000,
      closeTime: baseTime + (index + 1) * 60 * 60 * 1_000 - 1,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index,
    };
  });

  const snapshot = summarizeResearchCandles("BTCUSDT", candles, "Fixture Market");

  assert.equal(snapshot.symbol, "BTCUSDT");
  assert.equal(snapshot.timeframe, "1h");
  assert.equal(snapshot.candleCount, 80);
  assert.equal(snapshot.latestCandleAt, new Date(candles.at(-1).closeTime).toISOString());
  assert.ok(Number.isFinite(snapshot.ema20));
  assert.ok(Number.isFinite(snapshot.ema60));
  assert.ok(snapshot.ema20 > snapshot.ema60);
  assert.equal(snapshot.rsi14, 100);
  assert.ok(snapshot.atr14 > 0);
  assert.ok(snapshot.support < snapshot.resistance);
});

test("guided research answer leads with a conclusion and exposes evidence and invalidation", () => {
  const answer = guidedAssistantReply("BTC 当前行情与风险如何？", {
    generatedAt: "2026-08-18T08:00:00.000Z",
    market: {
      symbol: "BTCUSDT",
      timeframe: "1h",
      price: 64_200,
      change24hPct: 1.7,
      high24h: 65_100,
      low24h: 62_800,
      ema20: 63_900,
      ema60: 62_700,
      rsi14: 58.2,
      atr14: 720,
      support: 62_800,
      resistance: 65_100,
      candleCount: 120,
      latestCandleAt: "2026-08-18T08:00:00.000Z",
      source: "Fixture Market",
    },
    portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
  });

  assert.match(answer.text, /结论/);
  assert.match(answer.text, /关键证据/);
  assert.match(answer.text, /失效条件/);
  assert.match(answer.text, /下一步/);
  assert.match(answer.text, /EMA20/);
  assert.doesNotMatch(answer.text, /保证收益|已经替你下单/);
});
