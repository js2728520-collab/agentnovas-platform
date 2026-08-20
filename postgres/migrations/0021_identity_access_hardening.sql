-- Identity and access controls for the controlled beta.
-- This migration is additive and idempotent. Runtime code owns all state changes.

CREATE TABLE IF NOT EXISTS "auth_rate_limit_buckets" (
  "id" text PRIMARY KEY,
  "action" text NOT NULL CHECK ("action" IN (
    'login', 'forgot_password', 'reset_password', 'mfa_verify', 'bootstrap'
  )),
  "app_audience" text NOT NULL CHECK ("app_audience" IN (
    'client', 'operations', 'maintenance'
  )),
  "bucket_key_hash" text NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "blocked_until" timestamptz,
  "last_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("action", "app_audience", "bucket_key_hash")
);

CREATE INDEX IF NOT EXISTS "idx_auth_rate_limit_blocked_until"
  ON "auth_rate_limit_buckets" ("blocked_until")
  WHERE "blocked_until" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "user_mfa_totp_credentials" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "encrypted_secret" text NOT NULL,
  "encryption_key_version" integer NOT NULL DEFAULT 1 CHECK ("encryption_key_version" > 0),
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'active', 'disabled')),
  "last_accepted_counter" bigint,
  "enabled_at" timestamptz,
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_mfa_recovery_codes" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "code_hash")
);

CREATE INDEX IF NOT EXISTS "idx_user_mfa_recovery_codes_available"
  ON "user_mfa_recovery_codes" ("user_id", "created_at")
  WHERE "used_at" IS NULL;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "mfa_level" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "mfa_verified_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "idle_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "absolute_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "session_version" bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_mfa_level_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_mfa_level_check
      CHECK ("mfa_level" IN ('none', 'primary', 'totp', 'recovery'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_assurance_expiry_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_assurance_expiry_check
      CHECK (
        "idle_expires_at" IS NULL OR
        "absolute_expires_at" IS NULL OR
        "idle_expires_at" <= "absolute_expires_at"
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_version_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_version_check CHECK ("session_version" > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_sessions_active_assurance"
  ON "sessions" ("user_id", "app_audience", "absolute_expires_at", "idle_expires_at")
  WHERE "revoked_at" IS NULL;

ALTER TABLE "user_role_assignments"
  ADD COLUMN IF NOT EXISTS "scope_organization_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "scope_version" bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_scope_organizations_array_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_scope_organizations_array_check
      CHECK (
        jsonb_typeof("scope_organization_ids_json") = 'array' AND
        jsonb_array_length("scope_organization_ids_json") <= 64
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_expiry_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_expiry_check
      CHECK ("expires_at" IS NULL OR "expires_at" > "effective_at");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_scope_version_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_scope_version_check CHECK ("scope_version" > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "rbac_revocation_tombstones" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "revoked_assignment_id" text REFERENCES "user_role_assignments"("id") ON DELETE SET NULL,
  "revoked_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "revoked_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "revoked_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "application_id")
);

CREATE INDEX IF NOT EXISTS "idx_rbac_revocation_tombstones_application"
  ON "rbac_revocation_tombstones" ("application_id", "revoked_at" DESC);
