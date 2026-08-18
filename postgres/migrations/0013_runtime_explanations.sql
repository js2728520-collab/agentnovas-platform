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

ALTER TABLE strategy_runtime_events
  ADD COLUMN IF NOT EXISTS explanation_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS explanation_json jsonb,
  ADD COLUMN IF NOT EXISTS explanation_model_name text,
  ADD COLUMN IF NOT EXISTS explanation_duration_ms integer,
  ADD COLUMN IF NOT EXISTS explanation_error_code text,
  ADD COLUMN IF NOT EXISTS explanation_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategy_runtime_events_explanation_status_check'
      AND conrelid = 'strategy_runtime_events'::regclass
  ) THEN
    ALTER TABLE strategy_runtime_events
      ADD CONSTRAINT strategy_runtime_events_explanation_status_check
      CHECK (explanation_status IN (
        'not_requested', 'pending', 'running', 'retry_wait', 'completed', 'failed'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategy_runtime_events_explanation_duration_check'
      AND conrelid = 'strategy_runtime_events'::regclass
  ) THEN
    ALTER TABLE strategy_runtime_events
      ADD CONSTRAINT strategy_runtime_events_explanation_duration_check
      CHECK (explanation_duration_ms IS NULL OR explanation_duration_ms >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS strategy_runtime_explanation_jobs (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id) ON DELETE CASCADE,
  event_role text NOT NULL CHECK (event_role IN (
    'market_data', 'adversarial_review', 'risk'
  )),
  explanation_role text NOT NULL CHECK (explanation_role IN (
    'market_summary', 'adversarial_explanation', 'risk_explanation'
  )),
  profile_revision_id text NOT NULL REFERENCES llm_profile_revisions(id) ON DELETE RESTRICT,
  prompt_version text NOT NULL,
  prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'retry_wait', 'completed', 'failed'
  )),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, event_role),
  CHECK (
    (event_role = 'market_data' AND explanation_role = 'market_summary') OR
    (event_role = 'adversarial_review' AND explanation_role = 'adversarial_explanation') OR
    (event_role = 'risk' AND explanation_role = 'risk_explanation')
  )
);

CREATE INDEX IF NOT EXISTS idx_strategy_runtime_explanation_jobs_queue
  ON strategy_runtime_explanation_jobs (status, next_attempt_at, lease_expires_at, created_at);
