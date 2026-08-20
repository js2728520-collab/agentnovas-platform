import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../postgres/migrations/0021_identity_access_hardening.sql", import.meta.url);

test("identity hardening migration defines shared authentication throttles", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "auth_rate_limit_buckets"/);
  assert.match(migration, /"bucket_key_hash" text NOT NULL/);
  assert.match(migration, /"attempt_count" integer NOT NULL DEFAULT 0/);
  assert.match(migration, /"blocked_until" timestamptz/);
  assert.match(migration, /UNIQUE \("action", "app_audience", "bucket_key_hash"\)/);
});

test("identity hardening migration stores encrypted TOTP credentials and hashed recovery codes", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "user_mfa_totp_credentials"/);
  assert.match(migration, /"encrypted_secret" text NOT NULL/);
  assert.match(migration, /"last_accepted_counter" bigint/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "user_mfa_recovery_codes"/);
  assert.match(migration, /"code_hash" text NOT NULL/);
  assert.doesNotMatch(migration, /"recovery_code" text/);
});

test("identity hardening migration adds bounded session assurance fields", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const column of [
    "mfa_level",
    "mfa_verified_at",
    "last_seen_at",
    "idle_expires_at",
    "absolute_expires_at",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.match(migration, /sessions_mfa_level_check/);
});

test("identity hardening migration makes RBAC revocation and assignment scope explicit", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "rbac_revocation_tombstones"/);
  assert.match(migration, /UNIQUE \("user_id", "application_id"\)/);
  assert.match(migration, /ALTER TABLE "user_role_assignments"[\s\S]+ADD COLUMN IF NOT EXISTS "scope_organization_ids_json" jsonb/);
  assert.match(migration, /user_role_assignments_scope_organizations_array_check/);
  assert.match(migration, /user_role_assignments_expiry_check/);
});

