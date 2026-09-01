import type {
  ClientDemoCardStatus,
  ClientDemoProviderStatus,
  ClientDemoReceiptStatus,
} from "@/packages/contracts/src/commercial-beta";
import type {
  TradingHallExecutionMode,
  TradingHallStrategy,
} from "@/packages/contracts/src/trading-hall";

export type TradingHallStrategyPresentation = {
  label: string;
  inactive: boolean;
};

function normalizedLabel(value: string) {
  const safeValue = value.trim().slice(0, 80);
  return safeValue ? `待确认（${safeValue}）` : "待确认（unknown）";
}

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

export function tradingHallRoundStatusLabel(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  const labels: Record<string, string> = {
    monitoring: "监控中，未形成候选机会",
    awaiting_data: "等待完整数据",
    needs_revision: "反方要求修改",
    risk_rejected: "风控拒绝新开仓",
    waiting: "AI 决策官暂缓",
    approved_shadow: "已批准，仅影子记录",
    approved_paper: "已批准，等待 paper 执行",
    paper_filled: "Paper 模拟成交，不代表真实成交",
    demo_not_sent: "平台 Demo 未发送",
    demo_failed: "平台测试环境验证失败，不影响 paper",
    demo_filled: "平台测试账户回执，不代表客户真实成交",
    hold: "AI 决策官暂缓",
  };
  return labels[normalized] ?? normalizedLabel(status ?? "");
}

export function tradingHallExplanationStatusLabel(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  const labels: Record<string, string> = {
    not_required: "本阶段无需模型补充",
    pending: "模型解释排队中",
    queued: "模型解释排队中",
    running: "模型解释生成中",
    completed: "模型解释已记录",
    reported: "模型解释已记录",
    failed: "模型解释失败",
    timeout: "模型解释超时",
  };
  return labels[normalized] ?? normalizedLabel(status ?? "");
}

export function tradingHallDemoProviderStatusLabel(status: ClientDemoProviderStatus | string) {
  const labels: Record<ClientDemoProviderStatus, string> = {
    NOT_CONFIGURED: "未配置",
    DISABLED: "已禁用",
    PAUSED: "已暂停",
    UNVERIFIED: "未验证",
    VERIFIED: "已验证",
    VERIFICATION_FAILED: "验证失败",
  };
  return labels[status as ClientDemoProviderStatus] ?? normalizedLabel(status);
}

export function tradingHallDemoCardStatusLabel(status: ClientDemoCardStatus | string) {
  const labels: Record<ClientDemoCardStatus, string> = {
    NOT_TESTED: "未测试",
    PAUSED: "已暂停",
    PENDING: "等待发送",
    RUNNING: "测试执行中",
    UNKNOWN: "状态未知",
    RETRY_WAIT: "等待重试",
    RECONCILE_WAIT: "等待回执核对",
    FILLED: "测试账户已成交",
    CANCELLED: "测试已取消",
    FAILED: "测试执行失败",
    QUARANTINED: "风险隔离中",
  };
  return labels[status as ClientDemoCardStatus] ?? normalizedLabel(status);
}

export function tradingHallDemoReceiptStatusLabel(status: ClientDemoReceiptStatus | string) {
  const labels: Record<ClientDemoReceiptStatus, string> = {
    ACCEPTED: "测试回执已接受",
    PARTIALLY_FILLED: "测试账户部分成交",
    FILLED: "测试账户已成交",
    CANCELLED: "测试回执已取消",
    REJECTED: "测试回执被拒绝",
  };
  return labels[status as ClientDemoReceiptStatus] ?? normalizedLabel(status);
}
