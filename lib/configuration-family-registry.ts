import { createHash } from "node:crypto";

import { ResearchApiError } from "./research-errors.ts";

const FEATURE_FLAG_V1 = Object.freeze({
  kind: "feature_flag",
  key: "client.strategy_research",
  audience: "client",
  schemaVersion: 1,
  testerId: "feature-flag-v1",
});

type ConfigurationFamilyInput = {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
};

function isRegisteredFeatureFlag(input: Omit<ConfigurationFamilyInput, "payload">) {
  return input.kind === FEATURE_FLAG_V1.kind
    && input.key === FEATURE_FLAG_V1.key
    && input.audience === FEATURE_FLAG_V1.audience
    && input.schemaVersion === FEATURE_FLAG_V1.schemaVersion;
}

function normalizeFeatureFlagV1(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_SCHEMA_INVALID", "功能开关 v1 payload 必须是对象", 422);
  }
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "enabled" || typeof value.enabled !== "boolean") {
    throw new ResearchApiError(
      "CONFIGURATION_FAMILY_SCHEMA_INVALID",
      "功能开关 v1 payload 只允许布尔字段 enabled",
      422,
      { fields: keys.filter((key) => key !== "enabled") },
    );
  }
  return { enabled: value.enabled };
}

export function normalizeConfigurationFamilyPayload(input: ConfigurationFamilyInput): Record<string, unknown> {
  if (input.kind !== "feature_flag") return input.payload;
  if (!isRegisteredFeatureFlag(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该功能开关配置族或 schema 尚未注册", 422);
  }
  return normalizeFeatureFlagV1(input.payload);
}

export function runRegisteredConfigurationFamilyTest(input: ConfigurationFamilyInput) {
  if (!isRegisteredFeatureFlag(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该配置族没有确定性测试器", 422);
  }
  const payload = normalizeFeatureFlagV1(input.payload);
  const evidence = JSON.stringify({
    testerId: FEATURE_FLAG_V1.testerId,
    kind: FEATURE_FLAG_V1.kind,
    key: FEATURE_FLAG_V1.key,
    audience: FEATURE_FLAG_V1.audience,
    schemaVersion: FEATURE_FLAG_V1.schemaVersion,
    payload,
    result: "passed",
  });
  return {
    result: "passed" as const,
    evidenceSha256: createHash("sha256").update(evidence, "utf8").digest("hex"),
    testerId: FEATURE_FLAG_V1.testerId,
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

export function evaluateRegisteredFeatureFlag(input: { environmentEnabled: boolean; payload: unknown }) {
  if (!input.environmentEnabled) return { enabled: false, reason: "environment_gate_disabled" as const };
  if (input.payload === null) return { enabled: true, reason: "no_active_configuration" as const };
  try {
    const payload = normalizeFeatureFlagV1(input.payload);
    return payload.enabled
      ? { enabled: true, reason: "enabled" as const }
      : { enabled: false, reason: "configuration_disabled" as const };
  } catch {
    return { enabled: false, reason: "configuration_invalid" as const };
  }
}
