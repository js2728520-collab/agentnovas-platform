import type { TradingHallExecutionMode, TradingHallStrategy } from "@/packages/contracts/src/trading-hall";

export type TradingHallStrategyPresentation = {
  label: string;
  inactive: boolean;
};

export function tradingHallEnvironmentLabel(mode: TradingHallExecutionMode | undefined) {
  if (mode === "paper") return "Paper 模拟环境";
  if (mode === "shadow") return "影子模拟环境";
  if (mode === "mixed_simulation") return "混合模拟环境";
  return "未配置模拟环境";
}

export function tradingHallStrategyPresentation(
  strategy: Pick<TradingHallStrategy, "status" | "executionMode">,
): TradingHallStrategyPresentation {
  const status = strategy.status.trim().toLowerCase();
  if (!status || ["not_deployed", "undeployed", "unavailable"].includes(status)) {
    return { label: "尚未部署", inactive: true };
  }
  if (status === "paused") return { label: "已暂停", inactive: true };
  if (status === "ended") return { label: "已结束", inactive: true };
  if (status === "failed") return { label: "运行失败", inactive: true };
  if (status === "active") {
    if (strategy.executionMode === "paper") return { label: "Paper 已部署", inactive: false };
    if (strategy.executionMode === "shadow") return { label: "影子模式已部署", inactive: false };
    if (strategy.executionMode === "mixed_simulation") return { label: "混合模拟已部署", inactive: false };
    return { label: "部署配置不可用", inactive: true };
  }
  return { label: `未知状态（${strategy.status}）`, inactive: true };
}
