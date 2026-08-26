import { createHash } from "node:crypto";

import {
  isStrategyAdmissionFamily,
  normalizeStrategyAdmissionPayload,
  runStrategyAdmissionTest,
} from "./strategy-admission-configuration.ts";
import {
  isMarketVisibilityFamily,
  normalizeMarketVisibilityPayload,
  runMarketVisibilityTest,
} from "./market-visibility-configuration.ts";
import {
  isRegisteredPromptSkillFamily,
  normalizeRegisteredPromptSkillPayload,
  runPromptSkillConfigurationTest,
} from "./prompt-skill-configuration.ts";
import { ResearchApiError } from "./research-errors.ts";

const FEATURE_FLAG_FAMILY = Object.freeze({
  kind: "feature_flag",
  key: "client.strategy_research",
  audience: "client",
});
const FEATURE_FLAG_TESTERS = Object.freeze({
  1: "feature-flag-v1",
  2: "feature-flag-v2",
});
const TARGET_KEYS = [
  "enabled",
  "userIds",
  "organizationIds",
  "applicationVersions",
  "rolloutPercentage",
  "startsAt",
  "endsAt",
] as const;
const TARGET_SELECTOR_KEYS = TARGET_KEYS.filter((key) => key !== "enabled");
const TARGET_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const EXPLICIT_OFFSET = /(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/i;
const MAX_TARGET_IDS = 100;
const MAX_TARGET_VERSIONS = 20;

type ConfigurationFamilyInput = {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
};

export type FeatureFlagEvaluationContext = {
  userId?: string | null;
  organizationIds?: readonly string[];
  applicationVersion?: string | null;
  now?: Date;
};

type NormalizedFeatureFlagV2Target = {
  enabled: boolean;
  userIds?: string[];
  organizationIds?: string[];
  applicationVersions?: string[];
  rolloutPercentage?: number;
  startsAt?: string;
  endsAt?: string;
};

type NormalizedFeatureFlagV2 = {
  defaultEnabled: boolean;
  target: NormalizedFeatureFlagV2Target;
};

function schemaError(message: string, fields?: string[]): never {
  throw new ResearchApiError(
    "CONFIGURATION_FAMILY_SCHEMA_INVALID",
    message,
    422,
    fields?.length ? { fields } : undefined,
  );
}

function object(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) schemaError(message);
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], message: string) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) schemaError(message, extras);
}

function isRegisteredFeatureFlag(input: Omit<ConfigurationFamilyInput, "payload">) {
  return input.kind === FEATURE_FLAG_FAMILY.kind
    && input.key === FEATURE_FLAG_FAMILY.key
    && input.audience === FEATURE_FLAG_FAMILY.audience
    && (input.schemaVersion === 1 || input.schemaVersion === 2);
}

function normalizeFeatureFlagV1(payload: unknown) {
  const value = object(payload, "功能开关 v1 payload 必须是对象");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "enabled" || typeof value.enabled !== "boolean") {
    schemaError("功能开关 v1 payload 只允许布尔字段 enabled", keys.filter((key) => key !== "enabled"));
  }
  return { enabled: value.enabled };
}

function normalizedList(
  value: unknown,
  label: string,
  maximum: number,
  valid: (item: string) => boolean,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    schemaError(`${label}必须是 1–${maximum} 个字符串的数组`);
  }
  const normalized = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (normalized.some((item) => !valid(item))) schemaError(`${label}包含无效值`);
  return [...new Set(normalized)].sort();
}

function normalizedTimestamp(value: unknown, label: string) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!EXPLICIT_OFFSET.test(raw)) schemaError(`${label}必须携带 Z 或明确 UTC offset`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) schemaError(`${label}不是有效时间`);
  return parsed.toISOString();
}

function normalizeFeatureFlagV2(payload: unknown): NormalizedFeatureFlagV2 {
  const value = object(payload, "功能开关 v2 payload 必须是对象");
  strictKeys(value, ["defaultEnabled", "target"], "功能开关 v2 payload 包含未知字段");
  if (typeof value.defaultEnabled !== "boolean") schemaError("功能开关 v2 defaultEnabled 必须是布尔值");
  const rawTarget = object(value.target, "功能开关 v2 target 必须是对象");
  strictKeys(rawTarget, TARGET_KEYS, "功能开关 v2 target 包含未知字段");
  if (typeof rawTarget.enabled !== "boolean") schemaError("功能开关 v2 target.enabled 必须是布尔值");
  if (!TARGET_SELECTOR_KEYS.some((key) => rawTarget[key] !== undefined)) {
    schemaError("功能开关 v2 target 至少需要一个用户、组织、版本、百分比或独立时窗条件");
  }

  const target: NormalizedFeatureFlagV2Target = { enabled: rawTarget.enabled };
  if (rawTarget.userIds !== undefined) {
    target.userIds = normalizedList(rawTarget.userIds, "指定用户 ID", MAX_TARGET_IDS, (item) => TARGET_IDENTIFIER.test(item));
  }
  if (rawTarget.organizationIds !== undefined) {
    target.organizationIds = normalizedList(rawTarget.organizationIds, "指定组织 ID", MAX_TARGET_IDS, (item) => TARGET_IDENTIFIER.test(item));
  }
  if (rawTarget.applicationVersions !== undefined) {
    target.applicationVersions = normalizedList(rawTarget.applicationVersions, "指定应用版本", MAX_TARGET_VERSIONS, (item) => SEMVER.test(item));
  }
  if (rawTarget.rolloutPercentage !== undefined) {
    if (!Number.isInteger(rawTarget.rolloutPercentage)
      || Number(rawTarget.rolloutPercentage) < 0
      || Number(rawTarget.rolloutPercentage) > 100) {
      schemaError("灰度百分比必须是 0–100 的整数");
    }
    target.rolloutPercentage = Number(rawTarget.rolloutPercentage);
  }
  if (rawTarget.startsAt !== undefined) target.startsAt = normalizedTimestamp(rawTarget.startsAt, "独立开始时间");
  if (rawTarget.endsAt !== undefined) target.endsAt = normalizedTimestamp(rawTarget.endsAt, "独立结束时间");
  if (target.startsAt && target.endsAt && Date.parse(target.startsAt) >= Date.parse(target.endsAt)) {
    schemaError("独立结束时间必须晚于开始时间");
  }
  return { defaultEnabled: value.defaultEnabled, target };
}

export function normalizeRegisteredFeatureFlagPayload(schemaVersion: number, payload: unknown) {
  if (schemaVersion === 1) return normalizeFeatureFlagV1(payload);
  if (schemaVersion === 2) return normalizeFeatureFlagV2(payload);
  throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该功能开关 schema 尚未注册", 422);
}

export function normalizeConfigurationFamilyPayload(input: ConfigurationFamilyInput): Record<string, unknown> {
  // Prompt/Skill v1（T3.1c-PS1）。注册后 normalize 就必须走严格 schema，不能再落回
  // 「原样保存 payload」——否则未注册期间写进去的宽松草稿会绕过安全包络检查。
  if (input.kind === "prompt" || input.kind === "skill") {
    return normalizeRegisteredPromptSkillPayload(input);
  }
  // 市场可见性（T2.1c 收口）。注册后同样必须走严格 schema，不能落回原样保存。
  if (input.kind === "market") {
    if (!isMarketVisibilityFamily(input)) {
      throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该市场配置族或 schema 尚未注册", 422);
    }
    return normalizeMarketVisibilityPayload(input.payload);
  }
  // 准入门槛（T4.2）。同样是注册后必须走严格 schema。
  if (input.kind === "strategy_admission") {
    if (!isStrategyAdmissionFamily(input)) {
      throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该准入门槛配置族或 schema 尚未注册", 422);
    }
    return normalizeStrategyAdmissionPayload(input.payload) as unknown as Record<string, unknown>;
  }
  if (input.kind !== "feature_flag") return input.payload;
  if (!isRegisteredFeatureFlag(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该功能开关配置族或 schema 尚未注册", 422);
  }
  return normalizeRegisteredFeatureFlagPayload(input.schemaVersion, input.payload);
}

export function runRegisteredConfigurationFamilyTest(input: ConfigurationFamilyInput) {
  if (isRegisteredPromptSkillFamily(input)) {
    return runPromptSkillConfigurationTest(input);
  }
  if (isMarketVisibilityFamily(input)) {
    return runMarketVisibilityTest(input);
  }
  if (isStrategyAdmissionFamily(input)) {
    return runStrategyAdmissionTest(input);
  }
  if (!isRegisteredFeatureFlag(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该配置族没有确定性测试器", 422);
  }
  const testerId = FEATURE_FLAG_TESTERS[input.schemaVersion as keyof typeof FEATURE_FLAG_TESTERS];
  const payload = normalizeRegisteredFeatureFlagPayload(input.schemaVersion, input.payload);
  const evidence = JSON.stringify({
    testerId,
    kind: FEATURE_FLAG_FAMILY.kind,
    key: FEATURE_FLAG_FAMILY.key,
    audience: FEATURE_FLAG_FAMILY.audience,
    schemaVersion: input.schemaVersion,
    payload,
    result: "passed",
  });
  return {
    result: "passed" as const,
    evidenceSha256: createHash("sha256").update(evidence, "utf8").digest("hex"),
    testerId,
  };
}

export function normalizeRegisteredConfigurationFamilyTestRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_TEST_INPUT_INVALID", "确定性测试请求必须是对象", 422);
  }
  const value = input as Record<string, unknown>;
  const extras = Object.keys(value).filter((key) => key !== "reason");
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (extras.length || reason.length < 3 || reason.length > 500) {
    throw new ResearchApiError(
      "CONFIGURATION_FAMILY_TEST_INPUT_INVALID",
      extras.length ? "确定性测试结果和证据只能由服务端生成" : "测试原因长度必须为 3–500 个字符",
      422,
      extras.length ? { fields: extras } : undefined,
    );
  }
  return { reason };
}

export function featureFlagRolloutBucket(key: string, userId: string) {
  return Number.parseInt(createHash("sha256").update(`${key}:${userId}`, "utf8").digest("hex").slice(0, 8), 16) % 10_000;
}

function targetMatches(target: NormalizedFeatureFlagV2Target, context: FeatureFlagEvaluationContext) {
  if (target.userIds || target.organizationIds) {
    const userMatch = Boolean(context.userId && target.userIds?.includes(context.userId));
    const organizationMatch = (context.organizationIds ?? []).some((id) => target.organizationIds?.includes(id));
    if (!userMatch && !organizationMatch) return false;
  }
  if (target.applicationVersions
    && (!context.applicationVersion || !target.applicationVersions.includes(context.applicationVersion))) {
    return false;
  }
  if (target.rolloutPercentage !== undefined) {
    if (!context.userId
      || featureFlagRolloutBucket(FEATURE_FLAG_FAMILY.key, context.userId) >= target.rolloutPercentage * 100) {
      return false;
    }
  }
  if (target.startsAt || target.endsAt) {
    const now = context.now?.getTime();
    if (now === undefined || !Number.isFinite(now)) return false;
    if (target.startsAt && now < Date.parse(target.startsAt)) return false;
    if (target.endsAt && now >= Date.parse(target.endsAt)) return false;
  }
  return true;
}

export function evaluateRegisteredFeatureFlag(input: {
  environmentEnabled: boolean;
  schemaVersion?: number;
  payload: unknown;
  context?: FeatureFlagEvaluationContext;
}) {
  if (!input.environmentEnabled) return { enabled: false, reason: "environment_gate_disabled" as const };
  if (input.payload === null) return { enabled: true, reason: "no_active_configuration" as const };
  try {
    const schemaVersion = input.schemaVersion ?? 1;
    const payload = normalizeRegisteredFeatureFlagPayload(schemaVersion, input.payload);
    if (schemaVersion === 1) {
      const global = payload as { enabled: boolean };
      return global.enabled
        ? { enabled: true, reason: "enabled" as const }
        : { enabled: false, reason: "configuration_disabled" as const };
    }
    const targeted = payload as NormalizedFeatureFlagV2;
    const matched = targetMatches(targeted.target, input.context ?? {});
    const enabled = matched
      ? targeted.target.enabled
      : targeted.defaultEnabled;
    return matched
      ? enabled
        ? { enabled: true, reason: "targeted_enabled" as const }
        : { enabled: false, reason: "targeted_disabled" as const }
      : enabled
        ? { enabled: true, reason: "default_enabled" as const }
        : { enabled: false, reason: "default_disabled" as const };
  } catch {
    return { enabled: false, reason: "configuration_invalid" as const };
  }
}
