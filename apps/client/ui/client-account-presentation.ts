const membershipPlans: Record<string, string> = {
  monthly_v1: "月卡",
  quarterly_v1: "季卡",
  annual_v1: "年卡",
  lifetime_v1: "终身会员",
  trial_monthly_equivalent: "试用会员",
};

const legalDocuments: Record<string, string> = {
  service_entity: "服务主体说明",
  jurisdiction: "服务地区说明",
  privacy: "隐私说明",
  terms: "服务条款",
  risk_disclosure: "风险提示",
  simulated_performance_fee_opinion: "模拟绩效服务费说明",
  refund_policy: "退款政策",
};

const strategies: Record<string, string> = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
};

const ledgerEntries: Record<string, { title: string; detail: string }> = {
  deposit_credit: { title: "充值入账", detail: "充值金额已计入账户余额" },
  membership_purchase: { title: "会员服务支付", detail: "使用账户余额购买会员服务" },
  performance_fee_payment: { title: "绩效服务费支付", detail: "使用账户余额结清绩效账单" },
  correction: { title: "余额调整", detail: "账户余额已按复核结果调整" },
};

const depositOrders: Record<string, string> = {
  ADDRESS_PROVISIONING: "正在生成地址",
  ADDRESS_UNKNOWN: "地址结果待人工排查",
  ADDRESS_FAILED: "地址生成失败",
  PENDING_CONFIRMATION: "等待到账",
  CONFIRMING: "链上确认中",
  MANUAL_REVIEW: "入账复核中",
  CREDITED: "已入账",
  FAILED: "未完成",
  RETURNED: "已退回",
};

const depositFunds: Record<string, string> = {
  NOT_CREDITED: "尚未入账",
  AVAILABLE: "余额可用",
  PARTIALLY_FROZEN: "部分余额受限",
  FROZEN: "余额暂不可用",
  RETURN_PENDING: "退回处理中",
  RETURNED: "已退回",
};

const depositRisks: Record<string, string> = {
  PASS: "正常",
  REVIEW: "待复核",
  BLOCK: "暂不可用",
};

export function membershipPlanLabel(value: string) {
  return membershipPlans[value] ?? "会员计划";
}

export function legalDocumentLabel(value: string) {
  return legalDocuments[value] ?? "服务说明";
}

export function strategyLabel(value: string) {
  return strategies[value] ?? "官方策略";
}

export function ledgerEntryLabel(value: string) {
  return ledgerEntries[value] ?? { title: "账户调整", detail: "账户余额发生变动" };
}

export function depositOrderLabel(value: string) {
  return depositOrders[value] ?? "处理中";
}

export function depositFundsLabel(value: string) {
  return depositFunds[value] ?? "状态更新中";
}

export function depositRiskLabel(value: string) {
  return depositRisks[value] ?? "待确认";
}
