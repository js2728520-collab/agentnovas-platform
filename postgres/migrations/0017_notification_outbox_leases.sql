ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "lease_owner" text,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_notifications_email_claim"
  ON "notification_deliveries" ("status", "scheduled_at", "lease_expires_at", "attempts")
  WHERE "channel" = 'email';

CREATE INDEX IF NOT EXISTS "idx_notifications_lease_owner"
  ON "notification_deliveries" ("lease_owner", "lease_expires_at")
  WHERE "lease_owner" IS NOT NULL;
