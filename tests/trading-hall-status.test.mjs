import assert from "node:assert/strict";
import test from "node:test";

import {
  tradingHallEnvironmentLabel,
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
