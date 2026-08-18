ALTER TABLE strategy_research_runs
  ADD COLUMN IF NOT EXISTS agent_role_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

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
