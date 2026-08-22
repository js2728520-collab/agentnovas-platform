CREATE TABLE IF NOT EXISTS market_data_snapshots (
  id text PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('research_run', 'runtime_cycle')),
  source_id text NOT NULL,
  exchange_account_id text NOT NULL,
  exchange text NOT NULL CHECK (exchange IN ('okx', 'binance', 'bybit')),
  instrument_id text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL CHECK (timeframe IN ('5m', '15m', '1h', '4h', '1d')),
  data_start timestamptz NOT NULL,
  data_end timestamptz NOT NULL,
  candle_count integer NOT NULL CHECK (candle_count > 0 AND candle_count <= 30000),
  candle_sha256 text NOT NULL CHECK (candle_sha256 ~ '^[a-f0-9]{64}$'),
  funding_rate_count integer NOT NULL CHECK (funding_rate_count >= 0 AND funding_rate_count <= 10000),
  funding_sha256 text NOT NULL CHECK (funding_sha256 ~ '^[a-f0-9]{64}$'),
  dataset_sha256 text NOT NULL CHECK (dataset_sha256 ~ '^[a-f0-9]{64}$'),
  instrument_rules_json jsonb NOT NULL,
  fee_schedule_json jsonb NOT NULL,
  data_quality_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_market_data_snapshots_lookup
  ON market_data_snapshots (exchange, symbol, timeframe, data_end DESC);
