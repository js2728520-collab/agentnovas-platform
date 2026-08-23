import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeConfigurationActivation,
  normalizeConfigurationApproval,
  normalizeConfigurationDraft,
  normalizeConfigurationSchedule,
  normalizeConfigurationTest,
} from "../lib/versioned-configuration-domain.ts";

test("configuration drafts are canonical, bounded and reject secret-bearing fields", () => {
  const left = normalizeConfigurationDraft({
    kind: "prompt",
    key: "research.market",
    audience: "shared",
    schemaVersion: 1,
    payload: { rollout: 25, enabled: false, nested: { b: 2, a: 1 } },
    reason: "建立首个受控功能开关草稿",
  });
  const right = normalizeConfigurationDraft({
    kind: "prompt",
    key: "research.market",
    audience: "shared",
    schemaVersion: 1,
    payload: { nested: { a: 1, b: 2 }, enabled: false, rollout: 25 },
    reason: "建立首个受控功能开关草稿",
  });
  assert.equal(left.payloadCanonical, right.payloadCanonical);
  assert.equal(left.payloadSha256, right.payloadSha256);
  assert.throws(() => normalizeConfigurationDraft({
    kind: "prompt", key: "research.market", audience: "shared", schemaVersion: 1,
    payload: { apiKey: "must-not-be-stored" }, reason: "不得把供应商密钥写入通用配置",
  }), (error) => error.code === "CONFIGURATION_SECRET_FIELD_FORBIDDEN" && error.status === 422);
  assert.throws(() => normalizeConfigurationDraft({
    kind: "prompt", key: "research.market", audience: "shared", schemaVersion: 1,
    payload: { content: "x".repeat(70_000) }, reason: "验证配置正文大小上限",
  }), (error) => error.code === "CONFIGURATION_PAYLOAD_TOO_LARGE" && error.status === 422);
});

test("configuration commands reject unknown fields and schedule timestamps without offsets", () => {
  assert.deepEqual(normalizeConfigurationTest({ result: "passed", evidenceSha256: "a".repeat(64), reason: "沙盒测试结果与预期一致" }), {
    result: "passed", evidenceSha256: "a".repeat(64), reason: "沙盒测试结果与预期一致",
  });
  assert.deepEqual(normalizeConfigurationApproval({ decision: "approve", reason: "独立复核配置差异与测试证据" }), {
    decision: "approve", reason: "独立复核配置差异与测试证据",
  });
  assert.throws(() => normalizeConfigurationSchedule({ scheduledFor: "2026-09-01T08:00:00", reason: "安排配置生效窗口" }, new Date("2026-08-23T00:00:00Z")),
    (error) => error.code === "CONFIGURATION_SCHEDULE_TIMEZONE_REQUIRED");
  assert.equal(normalizeConfigurationSchedule({ scheduledFor: "2026-09-01T08:00:00+08:00", reason: "安排配置生效窗口" }, new Date("2026-08-23T00:00:00Z")).scheduledFor,
    "2026-09-01T00:00:00.000Z");
  assert.deepEqual(normalizeConfigurationActivation({ action: "rollback", reason: "恢复此前已验证并生效的稳定配置" }), {
    action: "rollback", reason: "恢复此前已验证并生效的稳定配置",
  });
  assert.throws(() => normalizeConfigurationApproval({ decision: "approve", reason: "独立复核配置差异与测试证据", extra: true }),
    (error) => error.code === "CONFIGURATION_INPUT_UNKNOWN_FIELDS");
});
