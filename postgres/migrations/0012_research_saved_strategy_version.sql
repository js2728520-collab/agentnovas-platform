ALTER TABLE strategy_candidates
  ADD COLUMN IF NOT EXISTS saved_strategy_version_id text;
