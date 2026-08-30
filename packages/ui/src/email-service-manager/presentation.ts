import type { EmailDeliveryErrorKind } from "@/packages/notifications/src/email-service-management";

const statusLabels: Record<string, string> = {
  active: "已启用",
  applied: "已应用",
  applying: "应用中",
  authorized: "已授权",
  clear: "未抑制",
  configured: "已配置",
  degraded: "异常",
  delivered: "已送达",
  disabled: "已关闭",
  enabled: "已启用",
  failed: "失败",
  incomplete: "未完成",
  missing: "缺失",
  not_authorized: "未授权",
  not_tested: "未测试",
  offline: "离线",
  online: "在线",
  pending: "待应用",
  pending_verification: "待验证",
  queued: "排队中",
  ready: "就绪",
  sent: "已发送",
  suppressed: "已抑制",
  superseded: "已取代",
  unconfigured: "未配置",
  unverified: "未验证",
  verified: "已验证",
};

const errorMessages: Record<EmailDeliveryErrorKind, string> = {
  recipient_not_authorized: "测试收件地址未授权，请先在配置中授权。",
  recipient_suppressed: "收件地址已被退信、投诉或供应商抑制。",
  invalid_recipient: "收件地址格式无效。",
  provider_throttled: "Resend 正在限流，Worker 会按策略重试。",
  provider_rejected: "Resend 拒绝了本次投递。",
  provider_unreachable: "Resend 暂时不可达或响应异常。",
  unknown: "出现未分类的投递错误。",
};

export function emailServiceStatusLabel(value: string | null | undefined) {
  return statusLabels[value ?? ""] ?? value ?? "未知";
}

export function emailDeliveryErrorMessage(kind: EmailDeliveryErrorKind) {
  return errorMessages[kind];
}
