CREATE TABLE IF NOT EXISTS llm_profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  provider_name text NOT NULL,
  base_url text NOT NULL,
  model_name text NOT NULL,
  encrypted_api_key text NOT NULL,
  masked_api_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  current_revision_id text,
  created_by_user_id text NOT NULL,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_profile_revisions (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  name text NOT NULL,
  provider_name text NOT NULL,
  base_url text NOT NULL,
  model_name text NOT NULL,
  encrypted_api_key text NOT NULL,
  masked_api_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_llm_profile_revisions_profile
  ON llm_profile_revisions (profile_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS agent_role_bindings (
  id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN (
    'requirements', 'market_regime', 'proposal_a', 'proposal_b',
    'adversarial_review', 'risk_review', 'report'
  )),
  llm_profile_id text NOT NULL REFERENCES llm_profiles(id),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role)
);

CREATE TABLE IF NOT EXISTS runtime_explanation_bindings (
  id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN (
    'market_summary', 'adversarial_explanation', 'risk_explanation'
  )),
  llm_profile_id text NOT NULL REFERENCES llm_profiles(id),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role)
);

CREATE TABLE IF NOT EXISTS strategy_research_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  conversation_id text NOT NULL,
  exchange_account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('quick', 'standard', 'deep')),
  stage text NOT NULL DEFAULT 'requirements',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'retry_wait', 'paused_missing_role', 'awaiting_user_input',
    'completed', 'failed', 'cancelled'
  )),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  brief_json jsonb NOT NULL,
  agent_role_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb,
  final_conclusion text CHECK (final_conclusion IN ('QUALIFIED', 'NOT_QUALIFIED')),
  idempotency_key text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  cancel_requested_at timestamptz,
  event_sequence bigint NOT NULL DEFAULT 0,
  candidate_budget integer NOT NULL,
  backtest_budget integer NOT NULL,
  model_call_budget integer NOT NULL,
  backtests_used integer NOT NULL DEFAULT 0,
  model_calls_used integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_research_runs_queue
  ON strategy_research_runs (status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_research_runs_owner_time
  ON strategy_research_runs (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_research_steps (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES strategy_research_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  output_json jsonb,
  model_profile_id text,
  model_revision_id text,
  model_name text,
  prompt_version text,
  prompt_sha256 text,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  UNIQUE (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_research_steps_run_stage
  ON strategy_research_steps (run_id, stage, started_at);

CREATE TABLE IF NOT EXISTS strategy_agent_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES strategy_research_runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  role text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  content_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_strategy_agent_events_run_sequence
  ON strategy_agent_events (run_id, sequence);

CREATE TABLE IF NOT EXISTS strategy_candidates (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES strategy_research_runs(id) ON DELETE CASCADE,
  candidate_key text NOT NULL,
  strategy_family text NOT NULL,
  source_role text NOT NULL,
  dsl_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'validating', 'qualified', 'rejected'
  )),
  rank integer,
  score double precision,
  rejection_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_label text NOT NULL DEFAULT 'UNVERIFIED' CHECK (validation_label IN (
    'UNVERIFIED', 'EXPLORATION_ONLY', 'STANDARD_FAILED', 'STANDARD_VERIFIED'
  )),
  saved_strategy_id text,
  saved_strategy_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_candidates_run_rank
  ON strategy_candidates (run_id, rank, score DESC);

CREATE TABLE IF NOT EXISTS strategy_evaluations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES strategy_research_runs(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES strategy_candidates(id) ON DELETE CASCADE,
  evaluation_kind text NOT NULL,
  window_index integer NOT NULL DEFAULT 0,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  metrics_json jsonb NOT NULL,
  data_quality_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameter_set_sha256 text NOT NULL,
  data_slice_sha256 text NOT NULL,
  backtest_engine_version text NOT NULL,
  cost_scenario text NOT NULL,
  passed boolean NOT NULL DEFAULT false,
  is_final_holdout boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, evaluation_kind, window_index)
);

CREATE INDEX IF NOT EXISTS idx_strategy_evaluations_run_candidate
  ON strategy_evaluations (run_id, candidate_id, evaluation_kind);

CREATE TABLE IF NOT EXISTS market_candles (
  exchange text NOT NULL CHECK (exchange IN ('okx', 'binance', 'bybit')),
  symbol text NOT NULL,
  timeframe text NOT NULL,
  open_time timestamptz NOT NULL,
  close_time timestamptz NOT NULL,
  open numeric(30, 12) NOT NULL,
  high numeric(30, 12) NOT NULL,
  low numeric(30, 12) NOT NULL,
  close numeric(30, 12) NOT NULL,
  volume numeric(38, 12) NOT NULL,
  is_complete boolean NOT NULL DEFAULT true,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, symbol, timeframe, open_time)
);

CREATE INDEX IF NOT EXISTS idx_market_candles_lookup
  ON market_candles (exchange, symbol, timeframe, open_time DESC);

CREATE TABLE IF NOT EXISTS funding_rates (
  exchange text NOT NULL CHECK (exchange IN ('okx', 'binance', 'bybit')),
  symbol text NOT NULL,
  funding_time timestamptz NOT NULL,
  funding_rate numeric(20, 12) NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, symbol, funding_time)
);

CREATE INDEX IF NOT EXISTS idx_funding_rates_lookup
  ON funding_rates (exchange, symbol, funding_time DESC);

CREATE TABLE IF NOT EXISTS migration_batches (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  source_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE TABLE IF NOT EXISTS migration_table_checksums (
  migration_batch_id text NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  source_row_count bigint NOT NULL,
  target_row_count bigint NOT NULL,
  source_sha256 text NOT NULL,
  target_sha256 text NOT NULL,
  verified boolean NOT NULL,
  PRIMARY KEY (migration_batch_id, table_name)
);
