import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPlatformFactSnapshot } from "../packages/contracts/src/platform-facts.ts";
import { commercialBetaPlans, betaPaperCapitalUsdt } from "../packages/contracts/src/commercial-beta.ts";
import { officialTradingHallStrategies, tradingHallAgentCatalog } from "../packages/contracts/src/trading-hall.ts";
import {
  classifyAssistantIntent,
  guidedAssistantReply,
  intentNeedsDecisions,
  intentNeedsPlatformFacts,
} from "../lib/ai-chat-protocol.ts";

// AI 助手的平台事实。
//
// 助手要回答「月卡多少钱」「分成怎么算」「会不会动我的钱」。这些是合同事实，
// 编造就是向客户虚假陈述——所以快照里不能出现任何第二份数字。

test("会员档位逐项来自合同常量，没有第二份数字", () => {
  const snapshot = buildPlatformFactSnapshot();
  assert.equal(snapshot.membership.plans.length, commercialBetaPlans.length);
  for (const [index, plan] of snapshot.membership.plans.entries()) {
    const source = commercialBetaPlans[index];
    assert.equal(plan.name, source.name);
    assert.equal(plan.priceUsd, source.priceUsd);
    assert.equal(plan.durationDays, source.durationDays);
    assert.equal(plan.aiCredits, source.aiCredits);
    assert.equal(plan.performanceFeeRate, source.performanceFeeRate);
  }
});

test("平台事实文件里不出现写死的价格", async () => {
  // 唯一真源是 packages/contracts/src/commercial-beta.ts。这里复制一份数字，
  // 改价时助手就会向客户报旧价。
  const source = await readFile(new URL("../packages/contracts/src/platform-facts.ts", import.meta.url), "utf8");
  for (const plan of commercialBetaPlans) {
    assert.equal(source.includes(plan.priceUsd), false, `${plan.name} 的价格被写死在平台事实文件里`);
  }
  assert.equal(source.includes(betaPaperCapitalUsdt), false, "模拟本金被写死");
});

test("策略卡风控参数逐项来自合同常量", () => {
  const snapshot = buildPlatformFactSnapshot();
  assert.equal(snapshot.officialStrategies.length, officialTradingHallStrategies.length);
  for (const [index, strategy] of snapshot.officialStrategies.entries()) {
    const source = officialTradingHallStrategies[index];
    assert.equal(strategy.name, source.name);
    assert.equal(strategy.maxAssetAllocationPct, source.risk.maxAssetAllocationPct);
    assert.equal(strategy.dailyLossHaltPct, source.risk.dailyLossHaltPct);
    assert.equal(strategy.maxDrawdownPct, source.risk.maxDrawdownPct);
  }
});

test("七阶段决策链按顺序完整暴露", () => {
  const snapshot = buildPlatformFactSnapshot();
  assert.deepEqual(
    snapshot.decisionChain.map((stage) => stage.sequence),
    tradingHallAgentCatalog.map((agent) => agent.sequence),
  );
  assert.deepEqual(
    snapshot.decisionChain.map((stage) => stage.name),
    tradingHallAgentCatalog.map((agent) => agent.name),
  );
});

test("资金与权限边界必须写明提现、非托管与高水位线", () => {
  // 这三条是客户最关心也最容易被误解的，对应 INV-11 与 INV-5。
  const policies = buildPlatformFactSnapshot().policies.join("\n");
  assert.match(policies, /提现权限/);
  assert.match(policies, /非托管/);
  assert.match(policies, /高水位线/);
  assert.match(policies, /风控由确定性代码执行/);
});

// ---------------------------------------------------------------------------
// 意图分类：新意图必须排在旧意图前面，否则被关键词抢走
// ---------------------------------------------------------------------------

test("平台事实类问题不会被当成策略研究", () => {
  // 「策略卡收费吗」含「策略」，若排在 strategy_research 之后会被抢走。
  for (const message of ["月卡多少钱", "会员怎么收费", "策略卡收费吗", "绩效分成怎么算", "你们会动我的钱吗？会不会拿去托管", "AI 积分怎么充值", "这个平台是做什么的"]) {
    assert.equal(classifyAssistantIntent(message), "platform_info", message);
  }
});

test("决策分析类问题不会被当成持仓风险", () => {
  // 「这一轮为什么没开仓」含「仓」，若排在 portfolio_risk 之后会被抢走。
  for (const message of ["这一轮为什么没开仓", "风控拒绝的理由是什么", "七智能体决策链怎么运作", "帮我看下最近的决策轮"]) {
    assert.equal(classifyAssistantIntent(message), "decision_analysis", message);
  }
});

test("原有意图不受影响", () => {
  assert.equal(classifyAssistantIntent("这个回测夏普率靠谱吗"), "backtest_help");
  assert.equal(classifyAssistantIntent("我的持仓回撤多少"), "portfolio_risk");
  assert.equal(classifyAssistantIntent("帮我写个入场止损的策略"), "strategy_research");
  assert.equal(classifyAssistantIntent("BTC 现在什么走势"), "market_analysis");
});

test("只有需要的意图才装载快照，省提示词预算", () => {
  assert.equal(intentNeedsPlatformFacts("platform_info"), true);
  assert.equal(intentNeedsPlatformFacts("market_analysis"), false);
  assert.equal(intentNeedsDecisions("decision_analysis"), true);
  assert.equal(intentNeedsDecisions("portfolio_risk"), true);
  assert.equal(intentNeedsDecisions("market_analysis"), false);
});

// ---------------------------------------------------------------------------
// 无 LLM 配置时的确定性回答
// ---------------------------------------------------------------------------

const emptyContext = {
  generatedAt: "2026-08-22T00:00:00.000Z",
  market: null,
  portfolio: { openPositions: 0, positionSymbols: [], followedStrategies: [] },
};

test("没有模型时平台事实仍能逐字回答，且价格与合同一致", () => {
  const reply = guidedAssistantReply("月卡多少钱", { ...emptyContext, platform: buildPlatformFactSnapshot() });
  for (const plan of commercialBetaPlans) {
    assert.ok(reply.text.includes(plan.priceUsd), `回答缺少 ${plan.name} 价格`);
  }
  assert.match(reply.text, /高水位线/);
  assert.equal(reply.mode, "guided_rules");
});

test("没有决策轮时明说没有，不编造演示数据", () => {
  const reply = guidedAssistantReply("这一轮为什么没开仓", { ...emptyContext, decisions: [] });
  assert.match(reply.text, /没有可展示的决策轮/);
  assert.match(reply.text, /不会用演示数据补齐/);
});

test("有决策轮时说明风控拒绝理由", () => {
  const reply = guidedAssistantReply("风控拒绝的理由是什么", {
    ...emptyContext,
    decisions: [{
      decisionRoundId: "runtime:dep-1:1755840000000",
      strategyName: "AI 平衡型",
      symbol: "BTCUSDT",
      action: "hold",
      riskApproved: false,
      rejectionReasons: ["最大回撤边界已触发"],
      decidedAt: "2026-08-22T00:00:00.000Z",
      stages: [{ role: "risk", conclusion: "确定性风控拒绝新开仓" }],
    }],
  });
  assert.match(reply.text, /AI 平衡型/);
  assert.match(reply.text, /最大回撤边界已触发/);
  assert.match(reply.text, /runtime:dep-1:1755840000000/);
});
