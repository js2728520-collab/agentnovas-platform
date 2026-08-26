import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readClientFeatureFlagDecision } from "../lib/active-feature-flags.ts";
import { normalizeConfigurationDraft } from "../lib/versioned-configuration-domain.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("environment-disabled feature flag never queries configuration or widens capability", async () => {
  let queries = 0;
  const decision = await readClientFeatureFlagDecision({
    query: async () => { queries += 1; throw new Error("must not query"); },
  }, {
    key: "client.strategy_research",
    environmentEnabled: false,
  });
  assert.equal(queries, 0);
  assert.deepEqual(decision, {
    enabled: false,
    reason: "environment_gate_disabled",
    configurationVersionId: null,
    payloadSha256: null,
  });
});

test("missing active configuration preserves the existing environment gate", async () => {
  const decision = await readClientFeatureFlagDecision({
    query: async (sql, values) => {
      assert.match(sql, /configuration_client_active_feature_flag\(\$1\)/);
      assert.deepEqual(values, ["client.strategy_research"]);
      return { rows: [] };
    },
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.deepEqual(decision, {
    enabled: true,
    reason: "no_active_configuration",
    configurationVersionId: null,
    payloadSha256: null,
  });
});

test("active configuration narrows capability and binds the decision to a version", async () => {
  const payloadSha256 = createHash("sha256").update(JSON.stringify({ enabled: false }), "utf8").digest("hex");
  const decision = await readClientFeatureFlagDecision({
    query: async () => ({ rows: [{
      configuration_version_id: "feature-version-1",
      schema_version: 1,
      payload_json: { enabled: false },
      payload_sha256: payloadSha256,
    }] }),
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.deepEqual(decision, {
    enabled: false,
    reason: "configuration_disabled",
    configurationVersionId: "feature-version-1",
    payloadSha256,
  });
});

test("invalid projections and gateway failures fail closed without returning error prose", async () => {
  const invalid = await readClientFeatureFlagDecision({
    query: async () => ({ rows: [{
      configuration_version_id: "feature-version-invalid",
      schema_version: 1,
      payload_json: { enabled: "true" },
      payload_sha256: "b".repeat(64),
    }] }),
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.reason, "configuration_invalid");

  const unavailable = await readClientFeatureFlagDecision({
    query: async () => { throw new Error("database password leaked in error text"); },
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.deepEqual(unavailable, {
    enabled: false,
    reason: "configuration_unavailable",
    configurationVersionId: null,
    payloadSha256: null,
  });
  assert.equal(JSON.stringify(unavailable).includes("password"), false);
});

test("active payload must match its stored SHA-256 digest", async () => {
  const decision = await readClientFeatureFlagDecision({
    query: async () => ({ rows: [{
      configuration_version_id: "feature-version-digest-mismatch",
      schema_version: 1,
      payload_json: { enabled: true },
      payload_sha256: "c".repeat(64),
    }] }),
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, "configuration_invalid");
});

test("targeted active configuration evaluates only server-owned subject, release and time context", async () => {
  const normalized = normalizeConfigurationDraft({
    kind: "feature_flag",
    key: "client.strategy_research",
    audience: "client",
    schemaVersion: 2,
    payload: {
      defaultEnabled: false,
      target: {
        enabled: true,
        userIds: ["customer-1"],
        organizationIds: ["branch-a"],
        applicationVersions: ["v1.0.0-beta.6"],
        rolloutPercentage: 100,
        startsAt: "2026-08-24T01:00:00Z",
        endsAt: "2026-08-24T02:00:00Z",
      },
    },
    reason: "验证服务端上下文参与灰度功能开关判定",
  });
  const queryable = {
    query: async () => ({ rows: [{
      configuration_version_id: "feature-version-targeted",
      schema_version: 2,
      payload_json: normalized.payload,
      payload_sha256: normalized.payloadSha256,
    }] }),
  };
  const enabled = await readClientFeatureFlagDecision(queryable, {
    key: "client.strategy_research",
    environmentEnabled: true,
    userId: "customer-1",
    organizationIds: [],
    applicationVersion: "v1.0.0-beta.6",
    now: new Date("2026-08-24T01:30:00Z"),
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.reason, "targeted_enabled");
  assert.equal(enabled.configurationVersionId, "feature-version-targeted");

  const noReleaseIdentity = await readClientFeatureFlagDecision(queryable, {
    key: "client.strategy_research",
    environmentEnabled: true,
    userId: "customer-1",
    organizationIds: ["branch-a"],
    applicationVersion: null,
    now: new Date("2026-08-24T01:30:00Z"),
  });
  assert.equal(noReleaseIdentity.enabled, false);
  assert.equal(noReleaseIdentity.reason, "default_disabled");
});

test("strategy research GET and POST share the active feature flag gate", async () => {
  const route = await read("app/api/strategy-research/runs/route.client.ts");
  assert.match(route, /readClientFeatureFlagDecision/);
  assert.match(route, /key:\s*"client\.strategy_research"/);
  assert.match(route, /runtimeSetting\("STRATEGY_RESEARCH_ENABLED"\)/);
  assert.match(route, /safeRuntimeReleaseMetadata\(process\.env\)\.versionTag/);
  assert.match(route, /userId:\s*user\.id/);
  assert.match(route, /organizationIds:\s*user\.organizationId\s*\?\s*\[user\.organizationId\]\s*:\s*\[\]/);
  assert.equal(route.match(/await requireStrategyResearchEnabled\(user\)/g)?.length, 2);
  assert.equal(route.match(/const user = await requireResearchUser[\s\S]*?await requireStrategyResearchEnabled\(user\)/g)?.length, 2);
  assert.doesNotMatch(route, /function enabled\(\)/);
  assert.doesNotMatch(route, /request\.headers.*(?:version|organization|user)/i);
});
