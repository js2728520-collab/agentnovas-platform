import type {
  StrategyWorkRecordAdmissionStatus,
} from "@/packages/contracts/src/strategy-work-records";
import type { TradingHallRoundCompleteness } from "@/packages/contracts/src/trading-hall";

const evidenceLabels: Record<string, string> = {
  valid: "数据有效",
  candleCount: "K 线数量",
  gapsOrDuplicates: "缺口或重复",
  marketState: "市场状态",
  sampleSize: "样本数量",
  returnPct: "区间收益率",
  averageRangePct: "平均波动幅度",
  candleCloseTime: "K 线收盘时间",
  longEntry: "多头入场条件",
  shortEntry: "空头入场条件",
  dslExit: "策略退出条件",
  close: "收盘价",
  action: "动作",
  reason: "原因",
  strategyVersionId: "策略版本",
  objections: "反方意见",
  riskState: "风险状态",
  drawdownPct: "回撤",
  dailyLossPct: "当日亏损",
  consecutiveLosses: "连续亏损次数",
  halted: "已熔断",
  rejectionReasons: "拒绝原因",
  riskApproved: "风险准入通过",
  executionMode: "执行环境",
  orderIntent: "模拟意图",
  mode: "模式",
  side: "方向",
  executionTiming: "执行时机",
  requestedPrice: "请求价格",
  confirmedAtCandleCloseTime: "确认收盘时间",
  stale: "行情陈旧",
  latencyMs: "行情延迟（毫秒）",
  sourceStatus: "数据源状态",
  legacy: "历史兼容记录",
};

export function strategyWorkRecordDecisionLabel(value: string) {
  const safeValue = value.trim().slice(0, 80);
  const normalized = safeValue.toLowerCase();
  const labels: Record<string, string> = {
    enter_long: "计划开多",
    enter_short: "计划开空",
    exit: "计划退出",
    hold: "本轮观望",
    monitoring: "持续观察",
  };
  return labels[normalized] ?? `待确认（${safeValue || "unknown"}）`;
}

export function localizeStrategyWorkRecordLabel(value: string, translate: (text: string) => string) {
  const unknown = /^待确认（(.+)）$/.exec(value);
  return unknown ? `${translate("待确认")} (${unknown[1]})` : translate(value);
}

export function strategyWorkRecordExecutionModeLabel(value: "shadow" | "paper") {
  return value === "paper" ? "Paper 模拟盘" : "影子模拟盘";
}

export function strategyWorkRecordCompletenessLabel(value: TradingHallRoundCompleteness) {
  if (value === "complete") return "七阶段完整";
  if (value === "partial") return "阶段记录不完整";
  return "历史兼容记录";
}

export function strategyWorkRecordAdmissionPresentation(value: StrategyWorkRecordAdmissionStatus) {
  switch (value) {
    case "not_required":
      return {
        label: "本轮无需组合准入",
        detail: "公共结论为观望，按规则不为每个组合重复写入准入记录。",
      };
    case "not_recorded":
      return {
        label: "组合准入未记录",
        detail: "本轮不是纯观望，但服务端没有该组合的准入记录；不会推断为已放行或已执行。",
      };
    case "recorded":
      return {
        label: "组合准入已记录",
        detail: "服务端已保存该组合在本轮的确定性准入结果。",
      };
    case "risk_rejected":
      return {
        label: "组合风险拒绝",
        detail: "确定性风险规则拒绝本轮为该组合新开仓。",
      };
    case "failed":
      return {
        label: "组合准入失败",
        detail: "准入周期失败；不会把未知结果显示为已放行或已执行。",
      };
  }
}

function evidenceLabel(key: string) {
  return evidenceLabels[key] ?? key.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function evidenceScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未记录";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const items: string[] = value.flatMap((item): string[] => (
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? [evidenceScalar(item)]
        : []
    ));
    return items.length ? items.join("；") : "未记录";
  }
  return "未记录";
}

export function strategyWorkRecordEvidenceRows(evidence: Record<string, unknown>) {
  return Object.entries(evidence).flatMap(([key, value]) => {
    const parentLabel = evidenceLabel(key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => ({
        label: `${parentLabel} · ${evidenceLabel(childKey)}`,
        value: evidenceScalar(childValue),
      }));
    }
    return [{ label: parentLabel, value: evidenceScalar(value) }];
  });
}
