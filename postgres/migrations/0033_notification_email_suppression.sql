CREATE TABLE IF NOT EXISTS notification_email_suppressions (
  recipient_hash text PRIMARY KEY CHECK (recipient_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'provider_suppression', 'manual')),
  source_event_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text
);

CREATE INDEX IF NOT EXISTS idx_notification_email_suppressions_active
  ON notification_email_suppressions(active, updated_at DESC)
  WHERE active=true;

COMMENT ON TABLE notification_email_suppressions IS
  'Recipient hashes blocked after bounce, complaint, or provider suppression; raw email is never stored.';

-- Backfill only events that can be tied unambiguously to one of our email
-- deliveries.  The address is normalized and hashed inside PostgreSQL so the
-- migration never materializes or persists a plaintext suppression list.
WITH historical_events AS (
  SELECT event.event_id,
         COALESCE(NULLIF(event.event_type, ''), NULLIF(event.payload_json ->> 'type', '')) AS event_type,
         COALESCE(event.event_created_at, event.received_at) AS occurred_at,
         event.mapped_delivery_id,
         NULLIF(event.provider_message_id, '') AS stored_provider_message_id,
         NULLIF(event.payload_json #>> '{data,email_id}', '') AS payload_provider_message_id,
         NULLIF(event.payload_json #>> '{data,tags,notification_delivery_id}', '') AS payload_delivery_id
    FROM resend_webhook_events AS event
   WHERE COALESCE(NULLIF(event.event_type, ''), NULLIF(event.payload_json ->> 'type', ''))
           IN ('email.bounced', 'email.complained', 'email.suppressed')
     AND event.payload_json #>> '{data,from}' = 'noreply@agentnovas.com'
), trusted_matches AS (
  SELECT encode(sha256(convert_to(lower(btrim(users.email)), 'UTF8')), 'hex') AS recipient_hash,
         CASE event.event_type
           WHEN 'email.bounced' THEN 'bounce'
           WHEN 'email.complained' THEN 'complaint'
           WHEN 'email.suppressed' THEN 'provider_suppression'
         END AS reason,
         event.event_id AS source_event_id,
         event.occurred_at
    FROM historical_events AS event
    JOIN notification_deliveries AS delivery
      ON delivery.channel = 'email'
     AND (
       (event.mapped_delivery_id IS NOT NULL AND delivery.id = event.mapped_delivery_id)
       OR (
         event.mapped_delivery_id IS NULL
         AND event.payload_delivery_id IS NOT NULL
         AND delivery.id = event.payload_delivery_id
       )
       OR (
         event.mapped_delivery_id IS NULL
         AND event.payload_delivery_id IS NULL
         AND COALESCE(event.stored_provider_message_id, event.payload_provider_message_id) IS NOT NULL
         AND delivery.provider_message_id = COALESCE(event.stored_provider_message_id, event.payload_provider_message_id)
       )
     )
    JOIN users ON users.id = delivery.user_id
   WHERE (event.mapped_delivery_id IS NULL OR event.mapped_delivery_id = delivery.id)
     AND (event.payload_delivery_id IS NULL OR event.payload_delivery_id = delivery.id)
     AND (
       event.stored_provider_message_id IS NULL
       OR delivery.provider_message_id = event.stored_provider_message_id
     )
     AND (
       event.payload_provider_message_id IS NULL
       OR delivery.provider_message_id = event.payload_provider_message_id
     )
     AND (
       event.mapped_delivery_id IS NOT NULL
       OR event.payload_delivery_id IS NOT NULL
       OR event.stored_provider_message_id IS NOT NULL
       OR event.payload_provider_message_id IS NOT NULL
     )
     AND length(btrim(users.email)) <= 254
     AND lower(btrim(users.email)) NOT LIKE '%@unverified.agentnovas.local'
     AND lower(btrim(users.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
), deduplicated AS (
  SELECT DISTINCT ON (recipient_hash)
         recipient_hash, reason, source_event_id, occurred_at
    FROM trusted_matches
   ORDER BY recipient_hash,
            CASE reason
              WHEN 'complaint' THEN 3
              WHEN 'provider_suppression' THEN 2
              ELSE 1
            END DESC,
            occurred_at DESC,
            source_event_id DESC
)
INSERT INTO notification_email_suppressions
  (recipient_hash, reason, source_event_id, active, created_at, updated_at)
SELECT recipient_hash, reason, source_event_id, true, occurred_at, occurred_at
  FROM deduplicated
ON CONFLICT (recipient_hash) DO NOTHING;
