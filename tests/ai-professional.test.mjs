import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assistantResponseContract,
  buildSessionWorkingMemory,
  classifyAssistantIntent,
  guidedAssistantReply,
} from "../lib/ai-chat-protocol.ts";
import { summarizeResearchCandles } from "../lib/ai-research.ts";

test("classifies professional research workflows", () => {
  assert.equal(classifyAssistantIntent("BTC 当前走势、支撑位和阻力位怎么看？"), "market_analysis");
  assert.equal(classifyAssistantIntent("解释一下我的持仓风险"), "portfolio_risk");
  assert.equal(classifyAssistantIntent("帮我生成一个 1 小时趋势策略"), "strategy_research");
  assert.equal(classifyAssistantIntent("官方策略卡的风控参数和收费规则是什么？"), "platform_info");
  assert.equal(classifyAssistantIntent("BTC 1 小时 K 线、均线和波动怎么看？"), "market_analysis");
  assert.equal(classifyAssistantIntent("为什么这个策略回测后的最大回撤很大？"), "backtest_help");
  assert.equal(classifyAssistantIntent("这个策略的持仓风险和亏损敞口如何？"), "portfolio_risk");
  assert.equal(classifyAssistantIntent("这个策略当前的 BTC 走势依据是什么？"), "market_analysis");
  assert.equal(classifyAssistantIntent("你好"), "general");
});

test("sets a concrete evidence-first response contract for every assistant intent", () => {
  const market = assistantResponseContract("market_analysis");
  const decision = assistantResponseContract("decision_analysis");
  const platform = assistantResponseContract("platform_info");
  const strategy = assistantResponseContract("strategy_research");

  assert.match(market, /结论.*关键证据.*失效条件.*下一步/s);
  assert.match(market, /时间、周期、价格/);
  assert.match(market, /证据不足/);
  assert.match(decision, /放行或阻断/);
  assert.match(platform, /平台事实快照/);
  assert.match(platform, /不得推测/);
  assert.match(strategy, /最多 2 个/);
  assert.match(strategy, /会改变结论/);
  assert.match(strategy, /不得重复/);
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
  assert.match(memory.instruction, /不得再次追问/);
  assert.match(memory.instruction, /仅追问会改变结论/);
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

test("guided strategy research asks only two missing inputs and never repeats known boundaries", () => {
  const memory = buildSessionWorkingMemory([], "帮我做 BTC 1 小时趋势策略，最大回撤 10%，单次仓位 3%");
  const answer = guidedAssistantReply("帮我做 BTC 1 小时趋势策略，最大回撤 10%，单次仓位 3%", {
    generatedAt: "2026-08-18T08:00:00.000Z",
    market: null,
    portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
  }, memory);

  assert.match(answer.text, /待确认问题/);
  assert.match(answer.text, /止损/);
  assert.match(answer.text, /止盈/);
  assert.doesNotMatch(answer.text, /最大回撤.*待确认|单次仓位.*待确认/);
  assert.equal((answer.text.match(/问题 \d/g) ?? []).length, 2);
});

test("guided strategy research never claims readiness without an entry trigger", () => {
  const message = "BTC 1 小时策略，止损 2%，止盈 4%，最大回撤 10%，单次仓位 3%";
  const missingEntry = guidedAssistantReply(message, {
    generatedAt: "2026-08-18T08:00:00.000Z",
    market: null,
    portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
  }, buildSessionWorkingMemory([], message));

  assert.match(missingEntry.text, /入场触发条件/);
  assert.doesNotMatch(missingEntry.text, /关键边界已齐备/);

  const completeMessage = `${message}，EMA20 上穿 EMA60 时入场`;
  const complete = guidedAssistantReply(completeMessage, {
    generatedAt: "2026-08-18T08:00:00.000Z",
    market: null,
    portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
  }, buildSessionWorkingMemory([], completeMessage));

  assert.match(complete.text, /关键边界已齐备/);
  assert.match(complete.text, /入场触发、周期、仓位、止损、止盈和最大回撤均已明确/);
});

test("guided decision analysis names the deterministic blocking stage", () => {
  const answer = guidedAssistantReply("为什么这一轮没有开仓？", {
    generatedAt: "2026-08-18T08:00:00.000Z",
    market: null,
    portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
    decisions: [{
      decisionRoundId: "round-1",
      strategyName: "趋势策略",
      symbol: "BTCUSDT",
      action: "hold",
      riskApproved: false,
      rejectionReasons: ["最大回撤超限"],
      decidedAt: "2026-08-18T08:00:00.000Z",
      stages: [
        { role: "market_regime", conclusion: "震荡" },
        { role: "risk_review", conclusion: "拒绝新开仓" },
      ],
    }],
  });

  assert.match(answer.text, /阻断阶段：risk_review，拒绝新开仓/);
  assert.match(answer.text, /最大回撤超限/);
});
