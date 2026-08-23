import assert from "node:assert/strict";
import test from "node:test";

import { readClientFeatureFlagDecision } from "../lib/active-feature-flags.ts";

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
  const decision = await readClientFeatureFlagDecision({
    query: async () => ({ rows: [{
      configuration_version_id: "feature-version-1",
      schema_version: 1,
      payload_json: { enabled: false },
      payload_sha256: "a".repeat(64),
    }] }),
  }, { key: "client.strategy_research", environmentEnabled: true });
  assert.deepEqual(decision, {
    enabled: false,
    reason: "configuration_disabled",
    configurationVersionId: "feature-version-1",
    payloadSha256: "a".repeat(64),
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
