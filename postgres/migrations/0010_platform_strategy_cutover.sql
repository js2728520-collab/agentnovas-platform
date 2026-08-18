CREATE TABLE IF NOT EXISTS platform_strategy_migration_map (
  strategy_code text NOT NULL,
  symbol text NOT NULL,
  strategy_id text NOT NULL,
  strategy_version_id text NOT NULL,
  conversion_contract_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_code, symbol),
  UNIQUE (strategy_id),
  UNIQUE (strategy_version_id)
);

CREATE TABLE IF NOT EXISTS platform_subscription_migrations (
  legacy_subscription_id text PRIMARY KEY,
  strategy_subscription_id text NOT NULL,
  deployment_id text,
  selected_symbol text NOT NULL,
  selection_source text NOT NULL,
  conversion_contract_sha256 text NOT NULL,
  legacy_read_only_until timestamptz NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_runtime_cutovers (
  id text PRIMARY KEY,
  conversion_contract_sha256 text NOT NULL,
  deployment_mode text NOT NULL CHECK (deployment_mode IN ('shadow', 'paper')),
  migrated_subscription_count integer NOT NULL,
  legacy_read_only_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
