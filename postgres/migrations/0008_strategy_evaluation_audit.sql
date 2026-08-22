ALTER TABLE strategy_evaluations
  ADD COLUMN IF NOT EXISTS parameter_set_sha256 text,
  ADD COLUMN IF NOT EXISTS data_slice_sha256 text,
  ADD COLUMN IF NOT EXISTS backtest_engine_version text,
  ADD COLUMN IF NOT EXISTS cost_scenario text;

UPDATE strategy_evaluations
SET parameter_set_sha256 = COALESCE(parameter_set_sha256, repeat('0', 64)),
    data_slice_sha256 = COALESCE(data_slice_sha256, repeat('0', 64)),
    backtest_engine_version = COALESCE(backtest_engine_version, 'legacy-unknown'),
    cost_scenario = COALESCE(cost_scenario, 'legacy-unknown');

ALTER TABLE strategy_evaluations
  ALTER COLUMN parameter_set_sha256 SET NOT NULL,
  ALTER COLUMN data_slice_sha256 SET NOT NULL,
  ALTER COLUMN backtest_engine_version SET NOT NULL,
  ALTER COLUMN cost_scenario SET NOT NULL;

ALTER TABLE strategy_evaluations
  DROP CONSTRAINT IF EXISTS strategy_evaluations_parameter_set_sha256_check,
  ADD CONSTRAINT strategy_evaluations_parameter_set_sha256_check
    CHECK (parameter_set_sha256 ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS strategy_evaluations_data_slice_sha256_check,
  ADD CONSTRAINT strategy_evaluations_data_slice_sha256_check
    CHECK (data_slice_sha256 ~ '^[a-f0-9]{64}$');
