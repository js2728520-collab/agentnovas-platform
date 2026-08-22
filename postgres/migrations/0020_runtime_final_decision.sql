ALTER TABLE strategy_runtime_events
  DROP CONSTRAINT IF EXISTS strategy_runtime_events_role_check;

ALTER TABLE strategy_runtime_events
  ADD CONSTRAINT strategy_runtime_events_role_check
  CHECK (role IN (
    'market_data', 'technical_analysis', 'strategy_decision', 'adversarial_review',
    'risk', 'decision', 'execution', 'audit'
  ));

COMMENT ON COLUMN strategy_runtime_events.role IS
  'New cycles use seven product roles ending with decision and execution. audit is retained only for legacy rows.';
