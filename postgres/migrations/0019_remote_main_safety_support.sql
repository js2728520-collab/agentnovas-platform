CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" text PRIMARY KEY,
  "section" text NOT NULL CHECK ("section" IN ('system', 'features', 'billing', 'integrations', 'security')),
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("section")
);

CREATE INDEX IF NOT EXISTS "idx_platform_settings_updated"
  ON "platform_settings" ("updated_at");

CREATE TABLE IF NOT EXISTS "trading_emergency_stops" (
  "id" text PRIMARY KEY,
  "scope_key" text NOT NULL,
  "scope_type" text NOT NULL CHECK ("scope_type" IN ('platform', 'organization')),
  "organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "active" boolean NOT NULL DEFAULT false,
  "reason" text NOT NULL DEFAULT '',
  "activated_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "activated_at" timestamptz,
  "deactivated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("scope_key")
);

CREATE INDEX IF NOT EXISTS "idx_trading_emergency_active"
  ON "trading_emergency_stops" ("active", "scope_type");
