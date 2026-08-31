import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../scripts/seed-preview-mock-data.mjs", import.meta.url);

test("preview MOCK seed is explicitly authorized and bound to the test database", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /PREVIEW_MOCK_DATA_CONFIRMATION/);
  assert.match(source, /seed-agentnovas-test-sites/);
  assert.match(source, /PREVIEW_MOCK_DATABASE_HOST/);
  assert.match(source, /current_database\(\)/);
  assert.match(source, /acceptance_client_admin_v1/);
  assert.match(source, /acceptance_operations_admin_v1/);
  assert.match(source, /acceptance_maintenance_admin_v1/);
  assert.match(source, /pg_advisory_xact_lock/);
});

test("preview MOCK seed is deterministic, identifiable, and cannot enqueue external work", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /\[MOCK\]/);
  assert.match(source, /\.invalid/);
  assert.match(source, /ON CONFLICT/);
  assert.match(source, /channel[^\n]+in_app/);
  assert.match(source, /status[^\n]+delivered/);
  assert.doesNotMatch(source, /channel[^\n]+email/);
  assert.doesNotMatch(source, /status[^\n]+queued/);
  assert.doesNotMatch(source, /book[^\n]+live/);
  assert.doesNotMatch(source, /mode[^\n]+live/);
  assert.doesNotMatch(source, /payment_provider_configs\s+(?:SET|UPDATE|INSERT)/i);
});

test("preview MOCK seed exposes separately testable authorization and verification helpers", async () => {
  const seedModule = await import(scriptUrl.href);
  assert.equal(typeof seedModule.assertPreviewMockSeedEnvironment, "function");
  assert.equal(typeof seedModule.seedPreviewMockData, "function");
  assert.equal(typeof seedModule.verifyPreviewMockData, "function");

  assert.throws(() => seedModule.assertPreviewMockSeedEnvironment({
    databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/agentnovas",
    environment: {},
    execute: true,
  }), /confirmation/i);
  assert.throws(() => seedModule.assertPreviewMockSeedEnvironment({
    databaseUrl: "postgresql://postgres:secret@db.internal:5432/agentnovas",
    environment: {
      PREVIEW_MOCK_DATA_CONFIRMATION: "seed-agentnovas-test-sites",
      PREVIEW_MOCK_DATABASE_HOST: "another.internal",
    },
    execute: true,
  }), /host/i);
});
