import assert from "node:assert/strict";
import test from "node:test";

import {
  tradingHallDemoCardStatusLabel,
  tradingHallDemoProviderStatusLabel,
  tradingHallEnvironmentLabel,
  tradingHallExplanationStatusLabel,
  tradingHallRoundStatusLabel,
  tradingHallStrategyPresentation,
} from "../apps/client/ui/trading-hall-status.ts";

test("trading hall environment labels describe configuration without claiming runtime activity", () => {
  assert.equal(tradingHallEnvironmentLabel("paper"), "Paper 模拟环境");
  assert.equal(tradingHallEnvironmentLabel("shadow"), "影子模拟环境");
  assert.equal(tradingHallEnvironmentLabel("mixed_simulation"), "混合模拟环境");
  assert.equal(tradingHallEnvironmentLabel("unavailable"), "未配置模拟环境");
});

test("trading hall strategy states exhaust the production deployment lifecycle", () => {
  const cases = [
    ["not_deployed", "paper", "尚未部署", true],
    ["active", "paper", "Paper 已部署", false],
    ["active", "shadow", "影子模式已部署", false],
    ["active", "mixed_simulation", "混合模拟已部署", false],
    ["active", "unavailable", "部署配置不可用", true],
    ["paused", "paper", "已暂停", true],
    ["ended", "paper", "已结束", true],
    ["failed", "paper", "运行失败", true],
    ["future_state", "paper", "未知状态（future_state）", true],
  ];
  for (const [status, executionMode, label, inactive] of cases) {
    assert.deepEqual(
      tradingHallStrategyPresentation({ status, executionMode }),
      { label, inactive },
      `${status}/${executionMode}`,
    );
  }
});

test("deployment state is independent from whether a decision cycle exists", () => {
  assert.deepEqual(
    tradingHallStrategyPresentation({ status: "paused", executionMode: "paper" }),
    { label: "已暂停", inactive: true },
  );
});

test("decision round labels describe public hall states without inventing live fills", () => {
  const cases = [
    ["monitoring", "监控中，未形成候选机会"],
    ["awaiting_data", "等待完整数据"],
    ["needs_revision", "反方要求修改"],
    ["risk_rejected", "风控拒绝新开仓"],
    ["waiting", "AI 决策官暂缓"],
    ["approved_shadow", "已批准，仅影子记录"],
    ["approved_paper", "已批准，等待 paper 执行"],
    ["paper_filled", "Paper 模拟成交，不代表真实成交"],
    ["demo_not_sent", "平台 Demo 未发送"],
    ["demo_failed", "平台测试环境验证失败，不影响 paper"],
    ["demo_filled", "平台测试账户回执，不代表客户真实成交"],
    ["future_state", "待确认（future_state）"],
  ];
  for (const [status, label] of cases) {
    assert.equal(tradingHallRoundStatusLabel(status), label, status);
  }
});

test("explanation labels keep deterministic stages distinct from model summaries", () => {
  const cases = [
    ["not_required", "本阶段无需模型补充"],
    ["pending", "模型解释排队中"],
    ["running", "模型解释生成中"],
    ["completed", "模型解释已记录"],
    ["failed", "模型解释失败"],
    ["timeout", "模型解释超时"],
    ["future_state", "待确认（future_state）"],
  ];
  for (const [status, label] of cases) {
    assert.equal(tradingHallExplanationStatusLabel(status), label, status);
  }
});

test("demo provider and card labels stay bounded and customer-safe", () => {
  assert.equal(tradingHallDemoProviderStatusLabel("NOT_CONFIGURED"), "未配置");
  assert.equal(tradingHallDemoProviderStatusLabel("VERIFIED"), "已验证");
  assert.equal(tradingHallDemoProviderStatusLabel("VERIFICATION_FAILED"), "验证失败");
  assert.equal(tradingHallDemoProviderStatusLabel("future_state"), "待确认（future_state）");

  assert.equal(tradingHallDemoCardStatusLabel("NOT_TESTED"), "未测试");
  assert.equal(tradingHallDemoCardStatusLabel("RECONCILE_WAIT"), "等待回执核对");
  assert.equal(tradingHallDemoCardStatusLabel("FILLED"), "测试账户已成交");
  assert.equal(tradingHallDemoCardStatusLabel("FAILED"), "测试执行失败");
  assert.equal(tradingHallDemoCardStatusLabel("future_state"), "待确认（future_state）");
});
