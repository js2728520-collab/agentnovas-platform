import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRegisteredFeatureFlag,
  normalizeRegisteredConfigurationFamilyTestRequest,
  runRegisteredConfigurationFamilyTest,
} from "../lib/configuration-family-registry.ts";
import { normalizeConfigurationDraft } from "../lib/versioned-configuration-domain.ts";

const registeredDraft = (payload = { enabled: true }, overrides = {}) => ({
  kind: "feature_flag",
  key: "client.strategy_research",
  audience: "client",
  schemaVersion: 1,
  payload,
  reason: "建立策略研究模块的首个全局功能开关版本",
  ...overrides,
});

test("registered feature flag v1 accepts only the exact family and strict boolean payload", () => {
  assert.deepEqual(normalizeConfigurationDraft(registeredDraft()).payload, { enabled: true });

  for (const draft of [
    registeredDraft({ enabled: "true" }),
    registeredDraft({ enabled: true, rolloutPercentage: 50 }),
    registeredDraft({ enabled: true }, { key: "client.unknown_module" }),
    registeredDraft({ enabled: true }, { audience: "shared" }),
    registeredDraft({ enabled: true }, { schemaVersion: 2 }),
  ]) {
    assert.throws(
      () => normalizeConfigurationDraft(draft),
      (error) => error?.code === "CONFIGURATION_FAMILY_SCHEMA_INVALID"
        || error?.code === "CONFIGURATION_FAMILY_UNREGISTERED",
    );
  }
});

test("registered family test evidence is deterministic and bound to the exact payload", () => {
  const first = runRegisteredConfigurationFamilyTest(registeredDraft({ enabled: true }));
  const replay = runRegisteredConfigurationFamilyTest(registeredDraft({ enabled: true }));
  const disabled = runRegisteredConfigurationFamilyTest(registeredDraft({ enabled: false }));

  assert.deepEqual(first, replay);
  assert.equal(first.result, "passed");
  assert.match(first.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.testerId, "feature-flag-v1");
  assert.notEqual(first.evidenceSha256, disabled.evidenceSha256);
});

test("registered family test requests accept only an audited reason", () => {
  assert.deepEqual(
    normalizeRegisteredConfigurationFamilyTestRequest({ reason: "  运行策略研究功能开关确定性测试  " }),
    { reason: "运行策略研究功能开关确定性测试" },
  );
  for (const input of [
    { result: "passed", evidenceSha256: "a".repeat(64), reason: "浏览器伪造测试证据" },
    { reason: "短" },
    { reason: "x".repeat(501) },
    null,
  ]) {
    assert.throws(
      () => normalizeRegisteredConfigurationFamilyTestRequest(input),
      (error) => error?.code === "CONFIGURATION_FAMILY_TEST_INPUT_INVALID",
    );
  }
});

test("feature flag decisions preserve absence, narrow active capability and fail closed", () => {
  assert.deepEqual(evaluateRegisteredFeatureFlag({ environmentEnabled: false, payload: { enabled: true } }), {
    enabled: false,
    reason: "environment_gate_disabled",
  });
  assert.deepEqual(evaluateRegisteredFeatureFlag({ environmentEnabled: true, payload: null }), {
    enabled: true,
    reason: "no_active_configuration",
  });
  assert.deepEqual(evaluateRegisteredFeatureFlag({ environmentEnabled: true, payload: { enabled: false } }), {
    enabled: false,
    reason: "configuration_disabled",
  });
  assert.deepEqual(evaluateRegisteredFeatureFlag({ environmentEnabled: true, payload: { enabled: true } }), {
    enabled: true,
    reason: "enabled",
  });
  assert.deepEqual(evaluateRegisteredFeatureFlag({ environmentEnabled: true, payload: { enabled: "true" } }), {
    enabled: false,
    reason: "configuration_invalid",
  });
});
