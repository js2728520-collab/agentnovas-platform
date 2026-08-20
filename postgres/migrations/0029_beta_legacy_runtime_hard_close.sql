WITH candidates AS MATERIALIZED (
  SELECT id, status AS previous_status
  FROM strategy_deployments
  WHERE execution_product <> 'spot_usdt'
    AND status IN ('active', 'paused')
), disabled AS (
  UPDATE strategy_deployments AS deployment
  SET status = 'ended',
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = 'BETA_LEGACY_RUNTIME_DISABLED',
      last_error_message = 'Commercial Beta permits official spot_usdt paper runtime only',
      risk_state_json = jsonb_set(deployment.risk_state_json, '{halted}', 'true'::jsonb, true),
      updated_at = now()
  FROM candidates
  WHERE deployment.id = candidates.id
  RETURNING deployment.id, candidates.previous_status
)
INSERT INTO audit_logs (
  id, actor_user_id, action, subject_type, subject_id, before_json, after_json
)
SELECT
  'beta-hard-close:deployment:' || id,
  NULL,
  'strategy.runtime.beta_hard_close',
  'strategy_deployment',
  id,
  jsonb_build_object('status', previous_status)::text,
  jsonb_build_object(
    'status', 'ended',
    'errorCode', 'BETA_LEGACY_RUNTIME_DISABLED',
    'executionProduct', 'usdt_perpetual'
  )::text
FROM disabled
ON CONFLICT (id) DO NOTHING;

WITH cancelled AS (
  UPDATE strategy_research_runs
  SET status = 'cancelled',
      cancel_requested_at = COALESCE(cancel_requested_at, now()),
      completed_at = COALESCE(completed_at, now()),
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = 'BETA_LEGACY_RESEARCH_DISABLED',
      last_error_message = 'Commercial Beta excludes customer-key perpetual strategy research',
      event_sequence = event_sequence + 1,
      updated_at = now()
  WHERE status NOT IN ('completed', 'failed', 'cancelled')
  RETURNING id, event_sequence
)
INSERT INTO strategy_agent_events (
  id, run_id, sequence, role, event_type, title, content_json
)
SELECT
  'beta-hard-close:research:' || id,
  id,
  event_sequence,
  'audit',
  'beta_hard_close',
  '商业 Beta 已关闭旧永续策略研发任务',
  jsonb_build_object(
    'reasonCode', 'BETA_LEGACY_RESEARCH_DISABLED',
    'customerCredentialAccessed', false,
    'perpetualProviderAccessed', false
  )
FROM cancelled
ON CONFLICT (run_id, sequence) DO NOTHING;
