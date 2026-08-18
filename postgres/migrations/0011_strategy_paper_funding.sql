CREATE TABLE IF NOT EXISTS strategy_paper_funding_accruals (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  position_id text NOT NULL REFERENCES strategy_paper_positions(id) ON DELETE CASCADE,
  funding_time timestamptz NOT NULL,
  funding_rate double precision NOT NULL,
  notional_usdt numeric(30, 12) NOT NULL,
  funding_cost_usdt numeric(30, 12) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, funding_time)
);

CREATE INDEX IF NOT EXISTS idx_strategy_paper_funding_deployment_time
  ON strategy_paper_funding_accruals (deployment_id, funding_time);
