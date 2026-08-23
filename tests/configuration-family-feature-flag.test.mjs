import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRegisteredFeatureFlag,
  featureFlagRolloutBucket,
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

const targetedDraft = (payload = {
  defaultEnabled: false,
  target: {
    enabled: true,
    userIds: ["user-b", "user-a", "user-a"],
    organizationIds: ["branch-a"],
    applicationVersions: ["v1.0.0-beta.6"],
    rolloutPercentage: 40,
    startsAt: "2026-08-24T09:00:00+08:00",
    endsAt: "2026-08-24T10:00:00+08:00",
  },
}, overrides = {}) => registeredDraft(payload, { schemaVersion: 2, ...overrides });

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

test("feature flag v2 normalizes one strict targeting rule without identifiers or time ambiguity", () => {
  const normalized = normalizeConfigurationDraft(targetedDraft());
  assert.deepEqual(normalized.payload, {
    defaultEnabled: false,
    target: {
      enabled: true,
      userIds: ["user-a", "user-b"],
      organizationIds: ["branch-a"],
      applicationVersions: ["v1.0.0-beta.6"],
      rolloutPercentage: 40,
      startsAt: "2026-08-24T01:00:00.000Z",
      endsAt: "2026-08-24T02:00:00.000Z",
    },
  });
  assert.equal(runRegisteredConfigurationFamilyTest(targetedDraft()).testerId, "feature-flag-v2");

  for (const payload of [
    { defaultEnabled: false, target: { enabled: true } },
    { defaultEnabled: false, target: { enabled: true, userIds: ["customer@example.com"] } },
    { defaultEnabled: false, target: { enabled: true, rolloutPercentage: 20.5 } },
    { defaultEnabled: false, target: { enabled: true, applicationVersions: ["latest"] } },
    { defaultEnabled: false, target: { enabled: true, startsAt: "2026-08-24T01:00:00" } },
    { defaultEnabled: false, target: { enabled: true, startsAt: "2026-08-24T03:00:00Z", endsAt: "2026-08-24T02:00:00Z" } },
    { defaultEnabled: false, target: { enabled: true, rolloutPercentage: 40, unexpected: true } },
    { defaultEnabled: false, target: { enabled: true, rolloutPercentage: 40 }, unexpected: true },
  ]) {
    assert.throws(
      () => normalizeConfigurationDraft(targetedDraft(payload)),
      (error) => error?.code === "CONFIGURATION_FAMILY_SCHEMA_INVALID",
    );
  }
});

test("feature flag v2 applies stable percentage, subject OR, exact version and half-open UTC window", () => {
  const payload = normalizeConfigurationDraft(targetedDraft()).payload;
  assert.equal(featureFlagRolloutBucket("client.strategy_research", "user-a"), 3939);
  assert.equal(featureFlagRolloutBucket("client.strategy_research", "user-0"), 7904);
  const evaluate = (context) => evaluateRegisteredFeatureFlag({
    environmentEnabled: true,
    schemaVersion: 2,
    payload,
    context,
  });
  const base = {
    applicationVersion: "v1.0.0-beta.6",
    now: new Date("2026-08-24T01:30:00.000Z"),
  };
  assert.deepEqual(evaluate({ ...base, userId: "user-a", organizationIds: [] }), {
    enabled: true,
    reason: "targeted_enabled",
  });
  assert.deepEqual(evaluate({ ...base, userId: "user-a", organizationIds: ["branch-a"] }), {
    enabled: true,
    reason: "targeted_enabled",
  });
  assert.deepEqual(evaluate({ ...base, userId: "user-0", organizationIds: ["branch-a"] }), {
    enabled: false,
    reason: "default_disabled",
  });
  assert.deepEqual(evaluate({ ...base, userId: "user-a", organizationIds: [], applicationVersion: null }), {
    enabled: false,
    reason: "default_disabled",
  });
  assert.deepEqual(evaluate({ ...base, userId: "user-a", organizationIds: [], now: new Date("2026-08-24T02:00:00.000Z") }), {
    enabled: false,
    reason: "default_disabled",
  });
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
