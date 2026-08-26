import { canDisableNotification } from "../packages/domain/src/business-rules.ts";
import { ResearchApiError } from "./research-errors.ts";

const channels = new Set(["in_app", "email"]);
const categories = new Set([
  "membership_billing",
  "api_security",
  "risk_circuit_breaker",
  "trade_execution",
  "market_news",
]);
const modes = new Set(["instant", "digest", "important_only", "disabled"]);
const quietTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type NormalizedNotificationPreference = {
  channel: "in_app" | "email";
  category: string;
  mode: "instant" | "digest" | "important_only" | "disabled";
  quietStart: string | null;
  quietEnd: string | null;
};

function quietTime(value: unknown, key: "quietStart" | "quietEnd") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !quietTimePattern.test(value)) {
    throw new ResearchApiError("VALIDATION_ERROR", `${key} 必须是 HH:mm`, 422, { fields: [key] });
  }
  return value;
}

export function normalizeNotificationPreferenceBatch(body: Record<string, unknown>) {
  const source = Array.isArray(body.preferences)
    ? body.preferences
    : [{ channel: body.channel, category: body.category, mode: body.mode }];
  if (source.length < 1 || source.length > 10) {
    throw new ResearchApiError("VALIDATION_ERROR", "通知偏好数量必须为 1–10 项", 422, { fields: ["preferences"] });
  }
  const quietStart = quietTime(body.quietStart, "quietStart");
  const quietEnd = quietTime(body.quietEnd, "quietEnd");
  if ((quietStart && !quietEnd) || (!quietStart && quietEnd)) {
    throw new ResearchApiError("VALIDATION_ERROR", "免打扰开始和结束时间必须同时设置", 422, { fields: ["quietStart", "quietEnd"] });
  }
  const seen = new Set<string>();
  return source.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ResearchApiError("VALIDATION_ERROR", "通知偏好项目无效", 422, { fields: ["preferences"] });
    }
    const item = raw as Record<string, unknown>;
    const channel = typeof item.channel === "string" ? item.channel : "";
    const category = typeof item.category === "string" ? item.category : "";
    const mode = typeof item.mode === "string" ? item.mode : "";
    if (!channels.has(channel) || !categories.has(category) || !modes.has(mode)) {
      throw new ResearchApiError("VALIDATION_ERROR", "通知渠道、类别或模式无效", 422, { fields: ["preferences"] });
    }
    if (mode === "disabled" && !canDisableNotification(category)) {
      throw new ResearchApiError("MANDATORY_NOTIFICATION", "该安全或缴费通知不能关闭", 422);
    }
    const key = `${category}:${channel}`;
    if (seen.has(key)) {
      throw new ResearchApiError("DUPLICATE_NOTIFICATION_PREFERENCE", "通知偏好包含重复项目", 422, { fields: ["preferences"] });
    }
    seen.add(key);
    return { channel, category, mode, quietStart, quietEnd } as NormalizedNotificationPreference;
  });
}
