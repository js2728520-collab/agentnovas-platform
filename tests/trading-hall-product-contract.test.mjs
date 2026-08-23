import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  officialTradingHallStrategies,
  tradingHallAgentCatalog,
} from "../packages/contracts/src/trading-hall.ts";
import { evaluateStrategyRuntimeCycle } from "../packages/domain/src/strategy-runtime-engine.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the trading hall exposes the seven product roles in the approved order", () => {
  assert.deepEqual(tradingHallAgentCatalog.map((agent) => agent.key), [
    "market_analysis",
    "technical_analysis",
    "strategy_proposal",
    "adversarial_review",
    "risk_approval",
    "final_decision",
    "execution_receipt",
  ]);
  assert.deepEqual(tradingHallAgentCatalog.map((agent) => agent.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(tradingHallAgentCatalog.some((agent) => agent.key === "audit"), false);
});

test("the three official cards keep the approved spot universe and hard risk budgets", () => {
  assert.deepEqual(officialTradingHallStrategies.map((strategy) => strategy.code), [
    "ai_conservative",
    "ai_balanced",
    "ai_aggressive",
  ]);
  assert.deepEqual(officialTradingHallStrategies.map((strategy) => strategy.symbols), [
    ["BTCUSDT", "ETHUSDT"],
    ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  ]);
  assert.deepEqual(officialTradingHallStrategies.map((strategy) => strategy.risk.maxAssetAllocationPct), [15, 25, 35]);
  assert.deepEqual(officialTradingHallStrategies.map((strategy) => strategy.risk.maxTotalAllocationPct), [25, 50, 70]);
  assert.deepEqual(officialTradingHallStrategies.map((strategy) => strategy.risk.riskPerTradePct), [0.3, 0.5, 0.8]);
  assert.ok(officialTradingHallStrategies.every((strategy) => strategy.targetMarket === "spot_usdt"));
});

test("new deterministic runtime cycles include a final decision and keep audit outside the seven roles", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100,
    high: index === 29 ? 112 : 101,
    low: 99,
    close: index === 29 ? 111 : 100,
    volume: 100,
  }));
  const result = evaluateStrategyRuntimeCycle({
    deploymentId: "deployment-product-contract",
    strategyVersionId: "version-product-contract",
    dsl: {
      schemaVersion: 3,
      name: "合同测试",
      market: "usdt_perpetual",
      marginMode: "isolated",
      leverage: 1,
      symbol: "BTCUSDT",
      timeframe: "1h",
      direction: "long_only",
      legs: { long: {
        entry: { all: [{ type: "channel_breakout", period: 20, direction: "above" }] },
        exit: { any: [{ type: "candle_direction", direction: "bearish" }] },
        stopLossPct: 2,
        takeProfitPct: 4,
      } },
      risk: { positionSizePct: 5, maxDrawdownPct: 12, maxDailyLossPct: 3, maxConsecutiveLosses: 4 },
    },
    candles: rows,
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
    marketData: { evaluatedAt: rows.at(-1).closeTime + 1, latestClosedAt: rows.at(-1).closeTime, timeframe: "1h" },
  });

  assert.deepEqual(result.events.map((event) => event.role), [
    "market_data",
    "technical_analysis",
    "strategy_decision",
    "adversarial_review",
    "risk",
    "decision",
    "execution",
  ]);
  assert.equal(result.events.some((event) => event.role === "audit"), false);
  assert.equal(result.events[5].evidence.riskApproved, true);
});

test("trading hall API publishes the product boundary and structured decision rounds", async () => {
  const route = await source("app/api/trading-hall/route.client.ts");
  assert.match(route, /tradingHallAgentCatalog/);
  assert.match(route, /officialTradingHallStrategies/);
  assert.match(route, /productBoundary/);
  assert.match(route, /decisionRounds/);
  assert.match(route, /realOrderRoutingEnabled:\s*false/);
  assert.match(route, /targetMarket:\s*"spot_usdt"/);
  assert.match(route, /official_paper_positions/);
  assert.match(route, /paper_portfolio_id/);
});

test("client hall does not present static market data, fallback performance or a fake emergency stop", async () => {
  const page = await source("apps/client/ui/decision-hall.tsx");
  assert.doesNotMatch(page, /\$118,462\.40/);
  assert.doesNotMatch(page, /OKX DEMO/);
  assert.doesNotMatch(page, /className="danger">紧急停止/);
  assert.doesNotMatch(page, /\["AI 稳健型 · V2", "ETH 现货 · 2\.0%"/);
  assert.doesNotMatch(page, /#BTC-20260812-1031/);
  assert.match(page, /真实订单关闭/);
  assert.match(page, /decisionRounds/);
});

test("client entry surfaces share the seven-role contract and do not claim static live telemetry", async () => {
  const [page, css] = await Promise.all([source("apps/client/ui/decision-hall.tsx"), source("apps/client/ui/client-public-landing.module.css")]);
  // 原来是在遗留 SPA 的落地段落里切片断言；大厅现在是独立页面，整文件即该面。
  assert.match(page, /技术分析师/);
  assert.match(page, /AI 决策官/);
  assert.doesNotMatch(page, /审计 Agent|Audit Agent|Reconciliation/);
  assert.doesNotMatch(page, /\$118,462\b|62\/100|38\/100|86ms/);
  assert.doesNotMatch(page, /预计月化（目标）|const monthlyFloor|className="fake-chart"/);
  assert.doesNotMatch(page, /\{t\.live\}|\{t\.working\}/);
  assert.doesNotMatch(css, /7 AGENTS ONLINE/);
});

test("trading hall evidence is allowlisted and bounded before it reaches the client", async () => {
  const route = await source("app/api/trading-hall/route.client.ts");
  assert.match(route, /function publicScalar/);
  assert.match(route, /slice\(0, 2000\)/);
  assert.doesNotMatch(route, /evidence:\s*event\.evidence_json/);
});

test("七阶段结论从共享决策轮读，且界面明说这是本卡的公共轮", async () => {
  // 同一张策略卡在同一根已收盘 K 线上只判断一次，订阅该卡的所有客户看到同一轮
  // （ADR-0018）。七阶段内容不含任何客户数据——界面必须如实说明，
  // 不能让客户理解为「为我单独运行」。
  const [route, contract, meeting, paper] = await Promise.all([
    source("app/api/trading-hall/route.client.ts"),
    source("packages/contracts/src/trading-hall.ts"),
    source("apps/client/ui/decision-hall.tsx"),
    source("apps/client/ui/trading-experience.tsx"),
  ]);

  // 读取优先走决策轮，没有轮的（过渡期历史数据、永续部署）才回落到周期。
  assert.match(route, /decision_round_id = ANY/);
  assert.match(route, /decision_round_id IS NULL AND cycle_id = ANY/);
  assert.match(contract, /sharedDecisionRoundId: string \| null;/);
  assert.match(route, /sharedDecisionRoundId: deployment\.decision_round_id/);

  // 措辞：两处展示决策轮的界面都必须点明共享。
  assert.match(meeting, /本卡公共决策轮/);
  assert.match(paper, /公共决策轮/);
  assert.match(paper, /对订阅同一张卡的所有客户完全相同/);
  // 同时必须说清哪一部分仍是按客户单独判定的，否则会被理解成「大家仓位一样」。
  assert.match(paper, /你的仓位与风控准入按你的组合单独判定/);
});
