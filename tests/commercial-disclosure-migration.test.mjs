import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("0030 defines an auditable maker-checker disclosure bundle without weakening immutable acceptances", async () => {
  const migration = await read("postgres/migrations/0030_commercial_disclosure_trial.sql");
  for (const fragment of [
    "commercial_disclosure_publish_requests",
    "commercial_disclosure_bundles",
    "submitted_by_user_id",
    "reviewed_by_user_id",
    "snapshot_sha256",
    "product_identity_json",
    "commercial_legal_document_versions",
    "commercial_legal_acceptances",
  ]) assert.match(migration, new RegExp(fragment));
  assert.match(migration, /reviewed_by_user_id\s*<>\s*submitted_by_user_id/i);
  assert.match(migration, /status IN \('pending','approved','rejected'\)/);
  assert.doesNotMatch(migration, /DROP TABLE\s+commercial_legal_acceptances/i);
});

test("membership endpoint derives trial/read-only state without requiring a commercial plan join", async () => {
  const route = await read("app/api/membership/me/route.client.ts");
  assert.match(route, /membershipAccess/);
  assert.match(route, /LEFT JOIN commercial_plan_versions/);
  assert.match(route, /trial_monthly_equivalent/);
  assert.doesNotMatch(route, /FROM memberships m\s+JOIN commercial_plan_versions/);
});
