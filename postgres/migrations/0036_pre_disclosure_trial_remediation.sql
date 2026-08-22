-- Legacy invitation registration started the three-day trial before the
-- customer accepted the controlled commercial disclosure bundle. Freeze only
-- those legacy trial_started records that still lack a complete current bundle;
-- preserve their original timing in immutable operational evidence.

ALTER TABLE membership_access_events
  DROP CONSTRAINT IF EXISTS membership_access_events_event_type_check;

ALTER TABLE membership_access_events
  ADD CONSTRAINT membership_access_events_event_type_check
  CHECK (event_type IN (
    'trial_started', 'trial_reset_pending_disclosure', 'trial_grace_started',
    'membership_grace_started', 'read_only_started', 'membership_expired',
    'membership_restored'
  ));

WITH current_documents AS MATERIALIZED (
  SELECT id, document_type
  FROM commercial_legal_document_versions
  WHERE status = 'active'
    AND effective_at <= now()
    AND approved_at IS NOT NULL
), candidates AS MATERIALIZED (
  SELECT membership.id,
         membership.customer_id,
         membership.status AS previous_status,
         membership.starts_at AS previous_starts_at,
         membership.expires_at AS previous_expires_at,
         membership.grace_ends_at AS previous_grace_ends_at
  FROM memberships AS membership
  WHERE membership.plan_code = 'trial_monthly_equivalent'
    AND membership.status IN ('active', 'trial', 'grace', 'read_only', 'expired')
    AND EXISTS (
      SELECT 1
      FROM membership_access_events AS legacy_event
      WHERE legacy_event.membership_id = membership.id
        AND legacy_event.event_type = 'trial_started'
        AND legacy_event.dedupe_key = 'membership:' || membership.id || ':trial_started'
    )
    AND NOT (
      (SELECT count(*) FROM current_documents) = 7
      AND (SELECT count(DISTINCT document_type) FROM current_documents) = 7
      AND (
        SELECT count(DISTINCT document.id)
        FROM current_documents AS document
        JOIN commercial_legal_acceptances AS acceptance
          ON acceptance.document_version_id = document.id
         AND acceptance.user_id = membership.customer_id
      ) = 7
    )
  FOR UPDATE OF membership
), remediated AS (
  UPDATE memberships AS membership
  SET status = 'pending',
      starts_at = NULL,
      expires_at = NULL,
      grace_ends_at = NULL,
      max_active_strategies = 3,
      updated_at = now()
  FROM candidates AS candidate
  WHERE membership.id = candidate.id
  RETURNING membership.id,
            membership.customer_id,
            candidate.previous_status,
            candidate.previous_starts_at,
            candidate.previous_expires_at,
            candidate.previous_grace_ends_at
), remediation_events AS (
  INSERT INTO membership_access_events(
    id, membership_id, customer_id, event_type,
    effective_at, state_json, dedupe_key
  )
  SELECT 'trial-remediation-event:' || remediated.id,
         remediated.id,
         remediated.customer_id,
         'trial_reset_pending_disclosure',
         now(),
         jsonb_build_object(
           'reason', 'pre_disclosure_trial_started_early',
           'previousStatus', remediated.previous_status,
           'previousStartsAt', remediated.previous_starts_at,
           'previousExpiresAt', remediated.previous_expires_at,
           'previousGraceEndsAt', remediated.previous_grace_ends_at
         ),
         'membership:' || remediated.id || ':trial_reset_pending_disclosure'
  FROM remediated
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING membership_id
)
INSERT INTO audit_logs(
  id, actor_user_id, action, subject_type, subject_id, before_json, after_json
)
SELECT 'trial-remediation-audit:' || remediated.id,
       NULL,
       'commercial.trial_reset_pending_disclosure',
       'membership',
       remediated.id,
       jsonb_build_object(
         'status', remediated.previous_status,
         'startsAt', remediated.previous_starts_at,
         'expiresAt', remediated.previous_expires_at,
         'graceEndsAt', remediated.previous_grace_ends_at
       )::text,
       jsonb_build_object(
         'status', 'pending',
         'startsAt', NULL,
         'expiresAt', NULL,
         'graceEndsAt', NULL,
         'reason', 'pre_disclosure_trial_started_early'
       )::text
FROM remediated
JOIN remediation_events ON remediation_events.membership_id = remediated.id;

UPDATE official_paper_portfolios AS portfolio
SET access_status = CASE WHEN EXISTS (
      SELECT 1 FROM official_paper_positions AS position
      WHERE position.portfolio_id = portfolio.id
        AND position.status = 'open'
        AND position.quantity > 0
    ) THEN 'close_only' ELSE 'read_only' END,
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM membership_access_events AS event
  JOIN memberships AS membership ON membership.id = event.membership_id
  WHERE event.membership_id = portfolio.membership_id
    AND event.event_type = 'trial_reset_pending_disclosure'
    AND membership.status = 'pending'
);

UPDATE official_paper_order_intents AS intent
SET status = 'rejected',
    rejection_code = 'TRIAL_PENDING_DISCLOSURE'
FROM official_paper_portfolios AS portfolio
JOIN memberships AS membership ON membership.id = portfolio.membership_id
WHERE intent.portfolio_id = portfolio.id
  AND intent.action = 'buy'
  AND intent.status = 'pending'
  AND membership.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM membership_access_events AS event
    WHERE event.membership_id = membership.id
      AND event.event_type = 'trial_reset_pending_disclosure'
  );
