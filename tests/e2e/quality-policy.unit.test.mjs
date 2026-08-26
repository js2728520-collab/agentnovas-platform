import assert from "node:assert/strict";
import test from "node:test";

import {
  assertQualitySideEffectsDisabled,
  assertSafeFixtureDatabaseUrl,
  isAllowedQualityNetworkUrl,
  isExpectedQualityBrowserWarning,
  postgresUrlForSchema,
  qualityApplicationPorts,
  qualityBrowserOrigin,
  qualityLoopbackForward,
  qualitySchemaName,
  redactPotentialSecrets,
} from "../../scripts/quality/quality-policy.mjs";

test("quality runs reject enabled provider, email, payment, and Demo writes", () => {
  assert.doesNotThrow(() => assertQualitySideEffectsDisabled({}));
  assert.doesNotThrow(() => assertQualitySideEffectsDisabled({
    PAYMENT_WORKER_ENABLED: "false",
    NOTIFICATION_EMAIL_SEND_ENABLED: "false",
    DEMO_EXECUTION_WORKER_ENABLED: "false",
    PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "false",
  }));
  for (const key of [
    "PAYMENT_WORKER_ENABLED",
    "PAYMENT_PROVIDER_TESTS_ENABLED",
    "NOTIFICATION_WORKER_ENABLED",
    "NOTIFICATION_EMAIL_SEND_ENABLED",
    "DEMO_EXECUTION_WORKER_ENABLED",
    "PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED",
    "PLATFORM_DEMO_VERIFICATION_ENABLED",
    "STRATEGY_RESEARCH_ENABLED",
    "STRATEGY_RUNTIME_ENABLED",
  ]) {
    assert.throws(
      () => assertQualitySideEffectsDisabled({ [key]: "true" }),
      new RegExp(key),
    );
  }
});

test("quality fixture accepts only a local PostgreSQL administrator URL", () => {
  assert.equal(
    assertSafeFixtureDatabaseUrl("postgresql://quality@127.0.0.1:5432/postgres").hostname,
    "127.0.0.1",
  );
  assert.throws(
    () => assertSafeFixtureDatabaseUrl("postgresql://quality@db.production.example/app"),
    /local PostgreSQL/i,
  );
  assert.throws(
    () => assertSafeFixtureDatabaseUrl("https://127.0.0.1/postgres"),
    /PostgreSQL/i,
  );
});

test("quality schema and application URL are bounded and deterministic", () => {
  const schema = qualitySchemaName("run-123_attempt.2");
  assert.equal(schema, "quality_e2e_run_123_attempt_2");
  const applicationUrl = postgresUrlForSchema(
    "postgresql://quality@127.0.0.1:5432/postgres?application_name=quality",
    schema,
  );
  assert.equal(applicationUrl.searchParams.get("application_name"), "quality");
  assert.equal(applicationUrl.searchParams.get("options"), `-csearch_path=${schema}`);
  assert.throws(() => postgresUrlForSchema("postgresql://127.0.0.1/postgres", "public"), /schema/i);
});

test("quality application ports use a bounded optional offset", () => {
  assert.deepEqual(qualityApplicationPorts({}), { client: 3000, operations: 3001, maintenance: 3002 });
  assert.deepEqual(qualityApplicationPorts({ QUALITY_E2E_PORT_OFFSET: "100" }), {
    client: 3100,
    operations: 3101,
    maintenance: 3102,
  });
  for (const value of ["-1", "1.5", "63000", "invalid"]) {
    assert.throws(() => qualityApplicationPorts({ QUALITY_E2E_PORT_OFFSET: value }), /port offset/i);
  }
});

test("quality browser uses exact official origins and only forwards them to loopback", () => {
  const ports = qualityApplicationPorts({ QUALITY_E2E_PORT_OFFSET: "100" });
  assert.deepEqual(qualityBrowserOrigin("client", ports), {
    baseURL: "https://agentnovas.com:3100",
  });
  assert.deepEqual(qualityBrowserOrigin("operations", ports), {
    baseURL: "https://zht.agentnovas.com:3101",
  });
  assert.deepEqual(qualityBrowserOrigin("maintenance", ports), {
    baseURL: "https://xm.agentnovas.com:3102",
  });
  assert.deepEqual(qualityLoopbackForward("https://agentnovas.com:3100/_next/app.js?q=1", ports), {
    url: "http://127.0.0.1:3100/_next/app.js?q=1",
    host: "agentnovas.com:3100",
  });
  assert.equal(qualityLoopbackForward("https://agentnovas.com:3101/_next/app.js", ports), null);
  assert.equal(qualityLoopbackForward("https://api.binance.com:3100/api", ports), null);
});

test("browser network policy allows only loopback and DNS-pinned official app traffic", () => {
  for (const url of [
    "http://127.0.0.1:3000/",
    "http://localhost:3001/api/auth/me",
    "http://agentnovas.com:3100/notifications",
    "http://zht.agentnovas.com:3101/customers",
    "http://xm.agentnovas.com:3102/health",
    "ws://127.0.0.1:3002/_next/webpack-hmr",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "blob:http://127.0.0.1:3000/id",
  ]) assert.equal(isAllowedQualityNetworkUrl(url), true, url);
  for (const url of [
    "https://api.binance.com/api/v3/time",
    "https://api.resend.com/emails",
    "https://example.com/pixel.png",
    "https://other.agentnovas.com/api",
  ]) assert.equal(isAllowedQualityNetworkUrl(url), false, url);
});

test("quality browser warning policy ignores only Chromium's unused preload diagnostic", () => {
  assert.equal(isExpectedQualityBrowserWarning(
    "The resource https://agentnovas.com:3300/_next/static/chunks/example.js was preloaded using link preload but not used within a few seconds from the window's load event. Please make sure it has an appropriate `as` value and it is preloaded intentionally.",
  ), true);
  assert.equal(isExpectedQualityBrowserWarning("Failed to load resource: 403 Forbidden"), false);
  assert.equal(isExpectedQualityBrowserWarning(
    "The resource https://evil.invalid/example.js was preloaded using link preload but not used within a few seconds from the window's load event.",
  ), false);
});

test("evidence redaction removes credential-shaped values without retaining them", () => {
  const input = "Authorization: Bearer abc.def.ghi apiKey=sk-test-123456789 password=hunter2 token=raw-secret";
  const redacted = redactPotentialSecrets(input);
  assert.doesNotMatch(redacted, /abc\.def\.ghi|sk-test|hunter2|raw-secret/);
  assert.match(redacted, /\[REDACTED\]/);
});
