ALTER TABLE strategy_research_runs
  DROP CONSTRAINT IF EXISTS strategy_research_runs_status_check;

ALTER TABLE strategy_research_runs
  ADD CONSTRAINT strategy_research_runs_status_check CHECK (status IN (
    'queued', 'running', 'retry_wait', 'paused_missing_role', 'awaiting_user_input',
    'completed', 'failed', 'cancelled'
  ));
