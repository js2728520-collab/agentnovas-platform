CREATE TABLE IF NOT EXISTS strategy_deployments (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  strategy_id text NOT NULL,
  strategy_version_id text NOT NULL,
  strategy_subscription_id text,
  exchange_account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow', 'paper')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended', 'failed')),
  validation_label text NOT NULL CHECK (validation_label IN (
    'UNVERIFIED', 'EXPLORATION_ONLY', 'STANDARD_FAILED', 'STANDARD_VERIFIED'
  )),
  unverified_warning boolean NOT NULL DEFAULT true,
  position_size_pct double precision,
  stop_loss_pct_override double precision,
  idempotency_key text NOT NULL,
  next_cycle_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  last_cycle_sequence bigint NOT NULL DEFAULT 0,
  last_candle_close_at timestamptz,
  last_error_code text,
  last_error_message text,
  risk_state_json jsonb NOT NULL DEFAULT '{"drawdownPct":0,"dailyLossPct":0,"consecutiveLosses":0,"halted":false}'::jsonb,
  risk_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_deployments_runtime_queue
  ON strategy_deployments (status, next_cycle_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_strategy_deployments_owner
  ON strategy_deployments (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_runtime_cycles (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  fencing_token bigint NOT NULL,
  candle_open_time timestamptz NOT NULL,
  candle_close_time timestamptz NOT NULL,
  market_data_snapshot_id text,
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'skipped')),
  decision_json jsonb NOT NULL,
  order_intent_json jsonb,
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, sequence),
  UNIQUE (deployment_id, candle_close_time)
);

CREATE INDEX IF NOT EXISTS idx_strategy_runtime_cycles_deployment_sequence
  ON strategy_runtime_cycles (deployment_id, sequence DESC);

CREATE TABLE IF NOT EXISTS strategy_runtime_events (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 7),
  role text NOT NULL CHECK (role IN (
    'market_data', 'technical_analysis', 'strategy_decision', 'adversarial_review',
    'risk', 'execution', 'audit'
  )),
  event_type text NOT NULL,
  conclusion text NOT NULL,
  evidence_json jsonb NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  llm_used boolean NOT NULL DEFAULT false,
  model_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, sequence),
  UNIQUE (cycle_id, role)
);

CREATE TABLE IF NOT EXISTS strategy_paper_positions (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('long', 'short')),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  entry_price numeric(30, 12) NOT NULL CHECK (entry_price > 0),
  exit_price numeric(30, 12),
  opened_cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id),
  closed_cycle_id text REFERENCES strategy_runtime_cycles(id),
  fees_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  funding_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  realized_net_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_paper_positions_one_open
  ON strategy_paper_positions (deployment_id) WHERE status = 'open';

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

CREATE TABLE IF NOT EXISTS strategy_paper_order_intents (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('enter_long', 'enter_short', 'exit')),
  execution_timing text NOT NULL CHECK (execution_timing IN ('next_candle_open', 'intrabar_threshold')),
  requested_price numeric(30, 12),
  status text NOT NULL CHECK (status IN ('shadowed', 'pending', 'filled', 'cancelled')),
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  filled_at timestamptz
);

ALTER TABLE strategy_subscriptions
  ADD COLUMN IF NOT EXISTS strategy_version_id text,
  ADD COLUMN IF NOT EXISTS run_mode text,
  ADD COLUMN IF NOT EXISTS runtime_status text;

ALTER TABLE platform_decisions
  ADD COLUMN IF NOT EXISTS strategy_id text,
  ADD COLUMN IF NOT EXISTS strategy_version_id text,
  ADD COLUMN IF NOT EXISTS deployment_id text,
  ADD COLUMN IF NOT EXISTS runtime_cycle_id text;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS strategy_id text,
  ADD COLUMN IF NOT EXISTS strategy_version_id text,
  ADD COLUMN IF NOT EXISTS strategy_subscription_id text,
  ADD COLUMN IF NOT EXISTS runtime_cycle_id text;
