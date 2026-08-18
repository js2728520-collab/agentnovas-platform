ALTER TABLE strategy_research_runs
  ADD COLUMN IF NOT EXISTS model_call_budget integer NOT NULL DEFAULT 20
  CHECK (model_call_budget > 0);
