ALTER TABLE strategy_deployments
  ADD COLUMN IF NOT EXISTS strategy_subscription_id text,
  ADD COLUMN IF NOT EXISTS position_size_pct double precision,
  ADD COLUMN IF NOT EXISTS stop_loss_pct_override double precision;

ALTER TABLE strategy_deployments
  DROP CONSTRAINT IF EXISTS strategy_deployments_position_size_pct_check,
  ADD CONSTRAINT strategy_deployments_position_size_pct_check
    CHECK (position_size_pct IS NULL OR (position_size_pct >= 0.1 AND position_size_pct <= 30)),
  DROP CONSTRAINT IF EXISTS strategy_deployments_stop_loss_pct_override_check,
  ADD CONSTRAINT strategy_deployments_stop_loss_pct_override_check
    CHECK (stop_loss_pct_override IS NULL OR (stop_loss_pct_override >= 0.1 AND stop_loss_pct_override <= 50));

CREATE INDEX IF NOT EXISTS idx_strategy_deployments_subscription
  ON strategy_deployments (strategy_subscription_id) WHERE strategy_subscription_id IS NOT NULL;
