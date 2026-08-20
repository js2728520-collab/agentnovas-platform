ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "provider_event_type" text,
  ADD COLUMN IF NOT EXISTS "provider_event_at" timestamptz;

ALTER TABLE "resend_webhook_events"
  ADD COLUMN IF NOT EXISTS "event_created_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "provider_message_id" text,
  ADD COLUMN IF NOT EXISTS "mapped_delivery_id" text REFERENCES "notification_deliveries"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "processed_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_email_provider_message"
  ON "notification_deliveries" ("provider_message_id")
  WHERE "channel" = 'email' AND "provider_message_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_resend_webhook_provider_message"
  ON "resend_webhook_events" ("provider_message_id", "event_created_at" DESC)
  WHERE "provider_message_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_resend_webhook_mapped_delivery"
  ON "resend_webhook_events" ("mapped_delivery_id", "event_created_at" DESC)
  WHERE "mapped_delivery_id" IS NOT NULL;
