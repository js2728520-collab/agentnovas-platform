export const configurationKinds = ["brand", "domain", "protocol", "feature_flag", "prompt", "skill", "pricing"] as const;
export const configurationAudiences = ["client", "operations", "maintenance", "shared"] as const;

export function commandKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function shortHash(value: string | null | undefined, size = 12) {
  return value ? `${value.slice(0, size)}…` : "未提供";
}

export function parseConfigurationPayload(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置 payload 必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

export function localDateTimeWithOffset(value: string, timezoneOffsetMinutes: number) {
  if (!value) return "";
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  const sign = timezoneOffsetMinutes <= 0 ? "+" : "-";
  const absolute = Math.abs(timezoneOffsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${normalized}${sign}${hours}:${minutes}`;
}

export function offsetForLocalDateTime(value: string) {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTimezoneOffset();
}

export function defaultScheduleLocal() {
  const date = new Date(Date.now() + 5 * 60_000);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function changedTopLevelKeys(current: Record<string, unknown> | null, candidate: Record<string, unknown>) {
  if (!current) return Object.keys(candidate).sort();
  const keys = new Set([...Object.keys(current), ...Object.keys(candidate)]);
  return [...keys].filter((key) => JSON.stringify(current[key]) !== JSON.stringify(candidate[key])).sort();
}
