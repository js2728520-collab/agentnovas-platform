import type { NotificationItem } from "../../../packages/contracts/src/riverton-ui";

export type ClientNotificationPresentation = {
  category: string;
  title: string;
  detail: string;
};

const categoryLabels: Record<string, string> = {
  api_security: "安全",
  login_security: "安全",
  market_news: "行情",
  membership: "会员",
  membership_billing: "会员",
  performance_fee: "绩效账单",
  performance_fee_collection: "绩效账单",
  risk_circuit_breaker: "风险",
  strategy_lifecycle: "策略",
  trade_execution: "模拟交易",
  trading_suspended: "风险",
  wallet: "账户",
};

function text(payload: NotificationItem["payload"], key: string, fallback: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function localizedDateTime(value: unknown, locale = "zh-CN") {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}

function presentClientNotificationChinese(item: NotificationItem): ClientNotificationPresentation {
  const category = categoryLabels[item.category] ?? "平台";
  const strategyName = text(item.payload, "strategyName", "当前策略");
  const changeAt = localizedDateTime(item.payload.noticeEndsAt ?? item.payload.effectiveAt);

  switch (item.templateKey) {
    case "membership_order_created":
      return { category: "会员", title: "会员申请已创建", detail: "请按页面提示完成后续步骤；申请进度可在账户中心查看。" };
    case "membership_evidence_recorded":
    case "membership_submitted":
      return { category: "会员", title: "会员申请已提交", detail: "申请正在处理中，结果会通过通知告知。" };
    case "membership_rejected":
      return { category: "会员", title: "会员申请需要调整", detail: "请前往账户中心查看状态并按提示重新提交。" };
    case "membership_activated":
      return { category: "会员", title: "会员已激活", detail: "会员权益已生效，可在账户中心查看有效期和权益范围。" };
    case "membership_grace_started":
      return { category: "会员", title: "会员即将到期", detail: "当前权益已进入宽限期，请前往账户中心查看续费安排。" };
    case "membership_read_only":
      return { category: "会员", title: "账户已转为只读", detail: "部分会员功能暂不可用，请前往账户中心查看会员状态。" };
    case "performance_statement_generated":
      return { category: "绩效账单", title: "新的绩效账单", detail: "账单已生成，可在账户中心查看计算周期和明细。" };
    case "performance_assessment_recorded":
      return { category: "绩效账单", title: "绩效账单已确认", detail: "账单处理状态已更新，可前往账户中心查看。" };
    case "performance_payment_evidence_recorded":
      return { category: "绩效账单", title: "付款凭证已提交", detail: "凭证正在核验，处理结果会通过通知告知。" };
    case "performance_payment_rejected":
      return { category: "绩效账单", title: "付款凭证需要调整", detail: "请前往账户中心查看原因并重新提交。" };
    case "performance_fee_paid":
      return { category: "绩效账单", title: "绩效账单已结清", detail: "本期账单已完成处理，可在账户中心查看记录。" };
    case "deposit_credited":
    case "wallet_credited":
      return { category: "账户", title: "资金已入账", detail: "账户余额已经更新，可在账户中心查看账本明细。" };
    case "security_new_device":
      return { category: "安全", title: "新设备登录提醒", detail: "检测到新的登录设备；如非本人操作，请立即检查账户安全。" };
    case "security_network_changed":
      return { category: "安全", title: "登录环境变化", detail: "检测到登录网络发生变化；如有异常，请立即检查账户安全。" };
    case "strategy_delist_notice":
      return {
        category: "策略",
        title: "策略下架提醒",
        detail: changeAt
          ? `${strategyName}将于 ${changeAt} 调整，请及时检查跟随安排。`
          : `${strategyName}即将调整，请及时检查跟随安排。`,
      };
    case "strategy_modify_notice":
      return {
        category: "策略",
        title: "策略调整提醒",
        detail: changeAt
          ? `${strategyName}将于 ${changeAt} 更新，请及时查看策略说明。`
          : `${strategyName}即将更新，请及时查看策略说明。`,
      };
    case "strategy_auto_delisted_30d_threshold":
      return { category: "策略", title: "策略已停止跟随", detail: `${strategyName}已停止新的模拟决策，请检查当前组合安排。` };
    default:
      return category === "平台"
        ? { category, title: "账户有新的平台通知", detail: "通知详情已安全记录；如需协助，请联系客户支持。" }
        : { category, title: `账户有新的${category}通知`, detail: "请登录平台查看最新状态；如需协助，请联系客户支持。" };
  }
}

export function presentClientNotification(
  item: NotificationItem,
  options?: { locale?: string; translate?: (value: string) => string },
): ClientNotificationPresentation {
  const presentation = presentClientNotificationChinese(item);
  if (!options?.translate) return presentation;
  const translate = options?.translate ?? ((value: string) => value);
  const category = translate(presentation.category);
  const strategyName = translate(text(item.payload, "strategyName", "当前策略"));
  const changeAt = localizedDateTime(item.payload.noticeEndsAt ?? item.payload.effectiveAt, options?.locale);

  if (item.templateKey === "strategy_delist_notice") {
    return {
      category,
      title: translate("策略下架提醒"),
      detail: changeAt
        ? `${strategyName} ${translate("将于")} ${changeAt} ${translate("调整，请及时检查跟随安排。")}`
        : `${strategyName} ${translate("即将调整，请及时检查跟随安排。")}`,
    };
  }
  if (item.templateKey === "strategy_modify_notice") {
    return {
      category,
      title: translate("策略调整提醒"),
      detail: changeAt
        ? `${strategyName} ${translate("将于")} ${changeAt} ${translate("更新，请及时查看策略说明。")}`
        : `${strategyName} ${translate("即将更新，请及时查看策略说明。")}`,
    };
  }
  if (item.templateKey === "strategy_auto_delisted_30d_threshold") {
    return {
      category,
      title: translate("策略已停止跟随"),
      detail: `${strategyName} ${translate("已停止新的模拟决策，请检查当前组合安排。")}`,
    };
  }
  if (!categoryLabels[item.category]) {
    return {
      category,
      title: translate("账户有新的平台通知"),
      detail: translate("通知详情已安全记录；如需协助，请联系客户支持。"),
    };
  }
  if (presentation.title.startsWith("账户有新的") && presentation.title.endsWith("通知")) {
    return {
      category,
      title: `${translate("账户有新的")} ${category} ${translate("通知")}`,
      detail: translate("请登录平台查看最新状态；如需协助，请联系客户支持。"),
    };
  }
  return {
    category,
    title: translate(presentation.title),
    detail: translate(presentation.detail),
  };
}
