import { createHash } from "node:crypto";

import { ResearchApiError } from "./research-errors.ts";

export const CONFIGURATION_KINDS = ["brand", "domain", "protocol", "feature_flag", "prompt", "skill", "pricing"] as const;
export const CONFIGURATION_AUDIENCES = ["client", "operations", "maintenance", "shared"] as const;
export const CONFIGURATION_TEST_RESULTS = ["passed", "failed"] as const;
export const CONFIGURATION_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export const CONFIGURATION_ACTIVATION_ACTIONS = ["activate", "rollback"] as const;

export type ConfigurationKind = typeof CONFIGURATION_KINDS[number];
export type ConfigurationAudience = typeof CONFIGURATION_AUDIENCES[number];
export type ConfigurationTestResult = typeof CONFIGURATION_TEST_RESULTS[number];
export type ConfigurationApprovalDecision = typeof CONFIGURATION_APPROVAL_DECISIONS[number];
export type ConfigurationActivationAction = typeof CONFIGURATION_ACTIVATION_ACTIONS[number];
export type ConfigurationVersionStatus = "draft" | "test_failed" | "tested" | "rejected" | "approved" | "scheduled" | "active" | "superseded" | "rolled_back";

export type NormalizedConfigurationDraft = {
  kind: ConfigurationKind;
  key: string;
  audience: ConfigurationAudience;
  schemaVersion: number;
  payload: Record<string, unknown>;
  payloadCanonical: string;
  payloadSha256: string;
  reason: string;
};

export type NormalizedConfigurationTest = { result: ConfigurationTestResult; evidenceSha256: string; reason: string };
export type NormalizedConfigurationApproval = { decision: ConfigurationApprovalDecision; reason: string };
export type NormalizedConfigurationSchedule = { scheduledFor: string; reason: string };
export type NormalizedConfigurationActivation = { action: ConfigurationActivationAction; reason: string };

const CONFIGURATION_KEY = /^[a-z][a-z0-9_.-]{2,120}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPLICIT_OFFSET = /(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/i;
const SECRET_FIELD = /(?:^|[_-])(secret|password|passphrase|token|api[_-]?key|private[_-]?key|credential|authorization)(?:$|[_-])/i;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_DEPTH = 20;

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchApiError("CONFIGURATION_INPUT_INVALID", "配置发布请求必须是对象", 422);
  }
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: string[]) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new ResearchApiError("CONFIGURATION_INPUT_UNKNOWN_FIELDS", "配置发布请求包含不允许的字段", 422, { fields: extras });
}

function text(value: unknown, label: string, minimum = 3, maximum = 500) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ResearchApiError("CONFIGURATION_INPUT_INVALID", `${label}长度必须为 ${minimum}–${maximum} 个字符`, 422);
  }
  return normalized;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ResearchApiError("CONFIGURATION_INPUT_INVALID", `${label}无效`, 422);
  }
  return value as T;
}

function normalizedPayload(value: unknown) {
  const payload = inputObject(value);
  const stack: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > MAX_DEPTH) throw new ResearchApiError("CONFIGURATION_PAYLOAD_TOO_DEEP", `配置 payload 嵌套不能超过 ${MAX_DEPTH} 层`, 422);
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new ResearchApiError("CONFIGURATION_PAYLOAD_INVALID", "配置 payload 只能包含有限数字", 422);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!current.value || typeof current.value !== "object" || Object.getPrototypeOf(current.value) !== Object.prototype) {
      throw new ResearchApiError("CONFIGURATION_PAYLOAD_INVALID", "配置 payload 只能包含 JSON 值", 422);
    }
    for (const [key, item] of Object.entries(current.value)) {
      if (SECRET_FIELD.test(key)) {
        throw new ResearchApiError("CONFIGURATION_SECRET_FIELD_FORBIDDEN", "通用配置不能保存密钥、口令或 token 字段", 422, { fields: [key] });
      }
      if (item === undefined) throw new ResearchApiError("CONFIGURATION_PAYLOAD_INVALID", "配置 payload 不能包含 undefined", 422);
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return payload;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function normalizeConfigurationDraft(input: unknown): NormalizedConfigurationDraft {
  const value = inputObject(input);
  strictKeys(value, ["kind", "key", "audience", "schemaVersion", "payload", "reason"]);
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!CONFIGURATION_KEY.test(key)) throw new ResearchApiError("CONFIGURATION_KEY_INVALID", "配置 key 格式无效", 422);
  if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 || Number(value.schemaVersion) > 1_000_000) {
    throw new ResearchApiError("CONFIGURATION_SCHEMA_VERSION_INVALID", "schemaVersion 必须是 1–1000000 的整数", 422);
  }
  const payload = normalizedPayload(value.payload);
  const payloadCanonical = canonicalJson(payload);
  if (Buffer.byteLength(payloadCanonical, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new ResearchApiError("CONFIGURATION_PAYLOAD_TOO_LARGE", "配置 payload 不能超过 64 KiB", 422);
  }
  return {
    kind: oneOf(value.kind, CONFIGURATION_KINDS, "配置类型"),
    key,
    audience: oneOf(value.audience, CONFIGURATION_AUDIENCES, "配置 audience"),
    schemaVersion: Number(value.schemaVersion),
    payload,
    payloadCanonical,
    payloadSha256: createHash("sha256").update(payloadCanonical, "utf8").digest("hex"),
    reason: text(value.reason, "创建原因"),
  };
}

export function normalizeConfigurationTest(input: unknown): NormalizedConfigurationTest {
  const value = inputObject(input);
  strictKeys(value, ["result", "evidenceSha256", "reason"]);
  const evidenceSha256 = typeof value.evidenceSha256 === "string" ? value.evidenceSha256.trim().toLowerCase() : "";
  if (!SHA256.test(evidenceSha256)) throw new ResearchApiError("CONFIGURATION_EVIDENCE_INVALID", "测试证据 SHA-256 无效", 422);
  return { result: oneOf(value.result, CONFIGURATION_TEST_RESULTS, "测试结果"), evidenceSha256, reason: text(value.reason, "测试原因") };
}

export function normalizeConfigurationApproval(input: unknown): NormalizedConfigurationApproval {
  const value = inputObject(input);
  strictKeys(value, ["decision", "reason"]);
  return { decision: oneOf(value.decision, CONFIGURATION_APPROVAL_DECISIONS, "审批决定"), reason: text(value.reason, "审批原因") };
}

export function normalizeConfigurationSchedule(input: unknown): NormalizedConfigurationSchedule {
  const value = inputObject(input);
  strictKeys(value, ["scheduledFor", "reason"]);
  const raw = typeof value.scheduledFor === "string" ? value.scheduledFor.trim() : "";
  if (!EXPLICIT_OFFSET.test(raw)) throw new ResearchApiError("CONFIGURATION_SCHEDULE_TIMEZONE_REQUIRED", "scheduledFor 必须携带 Z 或明确 UTC offset", 422);
  const scheduled = new Date(raw);
  if (Number.isNaN(scheduled.getTime())) throw new ResearchApiError("CONFIGURATION_SCHEDULE_INVALID", "scheduledFor 不是有效时间", 422);
  return { scheduledFor: scheduled.toISOString(), reason: text(value.reason, "调度原因") };
}

export function normalizeConfigurationActivation(input: unknown): NormalizedConfigurationActivation {
  const value = inputObject(input);
  strictKeys(value, ["action", "reason"]);
  return { action: oneOf(value.action, CONFIGURATION_ACTIVATION_ACTIONS, "生效动作"), reason: text(value.reason, "生效原因") };
}
