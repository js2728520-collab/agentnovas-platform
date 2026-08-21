-- Give Client invitation registration an independently observable rate-limit
-- action. Reapplying the migration preserves rows and recreates only the
-- allowed-value constraint.

ALTER TABLE auth_rate_limit_buckets
  DROP CONSTRAINT IF EXISTS auth_rate_limit_buckets_action_check;

ALTER TABLE auth_rate_limit_buckets
  ADD CONSTRAINT auth_rate_limit_buckets_action_check
  CHECK (action IN (
    'login', 'register', 'forgot_password', 'reset_password',
    'mfa_verify', 'bootstrap'
  ));

-- Existing invited or paid Beta memberships may have been created before the
-- official three-card entitlement was frozen. Preserve all other membership
-- limits while making the three official Paper cards concurrently reachable.
UPDATE memberships
SET max_active_strategies = 3,
    updated_at = now()
WHERE plan_code IN (
  'trial_monthly_equivalent',
  'monthly_v1', 'quarterly_v1', 'annual_v1', 'lifetime_v1'
)
  AND max_active_strategies < 3;
