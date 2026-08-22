CREATE TABLE IF NOT EXISTS "resend_webhook_events" (
  "event_id" text PRIMARY KEY,
  "event_type" text,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_resend_webhook_events_received"
  ON "resend_webhook_events" ("received_at");

UPDATE "notification_provider_configs"
SET "sender_domain" = 'agentnovas.com', "updated_at" = now()
WHERE "provider" = 'resend' AND "channel" = 'email';
