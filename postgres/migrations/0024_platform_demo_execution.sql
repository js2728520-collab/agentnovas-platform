ALTER TABLE strategy_deployments
  ALTER COLUMN exchange_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS execution_product text NOT NULL DEFAULT 'usdt_perpetual',
  ADD COLUMN IF NOT EXISTS platform_strategy_code text,
  ADD COLUMN IF NOT EXISTS membership_id text,
  ADD COLUMN IF NOT EXISTS paper_portfolio_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_deployments_execution_product_check'
  ) THEN
    ALTER TABLE strategy_deployments
      ADD CONSTRAINT strategy_deployments_execution_product_check
      CHECK (execution_product IN ('usdt_perpetual', 'spot_usdt'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_deployments_platform_strategy_code_check'
  ) THEN
    ALTER TABLE strategy_deployments
      ADD CONSTRAINT strategy_deployments_platform_strategy_code_check
      CHECK (platform_strategy_code IS NULL OR platform_strategy_code IN (
        'ai_conservative', 'ai_balanced', 'ai_aggressive'
      ));
  END IF;
END $$;

ALTER TABLE market_data_snapshots
  ALTER COLUMN exchange_account_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS official_paper_portfolios (
  id text PRIMARY KEY,
  membership_id text NOT NULL,
  customer_id text NOT NULL,
  strategy_code text NOT NULL CHECK (strategy_code IN (
    'ai_conservative', 'ai_balanced', 'ai_aggressive'
  )),
  principal_usdt numeric(30, 12) NOT NULL DEFAULT 10000 CHECK (principal_usdt = 10000),
  cash_usdt numeric(30, 12) NOT NULL DEFAULT 10000 CHECK (cash_usdt >= 0),
  realized_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  fees_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (fees_usdt >= 0),
  access_status text NOT NULL DEFAULT 'active' CHECK (access_status IN ('active', 'close_only', 'read_only')),
  risk_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, strategy_code)
);

CREATE INDEX IF NOT EXISTS idx_official_paper_portfolios_customer
  ON official_paper_portfolios (customer_id, updated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_official_paper_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_usdt <> OLD.principal_usdt OR NEW.principal_usdt <> 10000 THEN
    RAISE EXCEPTION 'official paper principal is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_protect_official_paper_principal ON official_paper_portfolios;
CREATE TRIGGER trg_protect_official_paper_principal
BEFORE UPDATE ON official_paper_portfolios
FOR EACH ROW EXECUTE FUNCTION protect_official_paper_principal();

CREATE TABLE IF NOT EXISTS official_paper_positions (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL REFERENCES official_paper_portfolios(id) ON DELETE CASCADE,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  side text NOT NULL DEFAULT 'long' CHECK (side = 'long'),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  average_entry_price numeric(30, 12) NOT NULL CHECK (average_entry_price > 0),
  cost_basis_usdt numeric(30, 12) NOT NULL CHECK (cost_basis_usdt > 0),
  last_mark_price numeric(30, 12) NOT NULL CHECK (last_mark_price > 0),
  unrealized_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  realized_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_official_paper_positions_one_open_symbol
  ON official_paper_positions (portfolio_id, symbol) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS official_paper_order_intents (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL REFERENCES official_paper_portfolios(id) ON DELETE CASCADE,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  runtime_cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  execution_timing text NOT NULL CHECK (execution_timing IN ('next_candle_open', 'intrabar_threshold')),
  requested_price numeric(30, 12),
  status text NOT NULL CHECK (status IN ('shadowed', 'pending', 'filled', 'rejected', 'cancelled')),
  rejection_code text,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  filled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_official_paper_intents_pending
  ON official_paper_order_intents (deployment_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS official_paper_fill_receipts (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES official_paper_order_intents(id) ON DELETE CASCADE,
  portfolio_id text NOT NULL REFERENCES official_paper_portfolios(id) ON DELETE CASCADE,
  position_id text REFERENCES official_paper_positions(id),
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  fill_price numeric(30, 12) NOT NULL CHECK (fill_price > 0),
  notional_usdt numeric(30, 12) NOT NULL CHECK (notional_usdt > 0),
  fee_usdt numeric(30, 12) NOT NULL CHECK (fee_usdt >= 0),
  realized_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 128),
  filled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id)
);

CREATE TABLE IF NOT EXISTS official_paper_ledger_entries (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL REFERENCES official_paper_portfolios(id) ON DELETE CASCADE,
  fill_receipt_id text REFERENCES official_paper_fill_receipts(id),
  entry_type text NOT NULL CHECK (entry_type IN ('initial_cash', 'buy', 'sell', 'fee', 'realized_pnl')),
  amount_usdt numeric(30, 12) NOT NULL,
  balance_after_usdt numeric(30, 12) NOT NULL CHECK (balance_after_usdt >= 0),
  symbol text CHECK (symbol IS NULL OR symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_official_paper_ledger_cursor
  ON official_paper_ledger_entries (portfolio_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_official_paper_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'official paper ledger is append-only';
END $$;

DROP TRIGGER IF EXISTS trg_official_paper_ledger_immutable ON official_paper_ledger_entries;
CREATE TRIGGER trg_official_paper_ledger_immutable
BEFORE UPDATE OR DELETE ON official_paper_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_official_paper_ledger_mutation();

CREATE TABLE IF NOT EXISTS platform_demo_accounts (
  id text PRIMARY KEY,
  provider text NOT NULL UNIQUE CHECK (provider IN ('okx', 'binance', 'bybit')),
  label text NOT NULL,
  api_key_ciphertext text NOT NULL,
  secret_ciphertext text NOT NULL,
  passphrase_ciphertext text,
  enabled boolean NOT NULL DEFAULT false,
  kill_switch_enabled boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  last_verification_status text CHECK (last_verification_status IS NULL OR last_verification_status IN ('passed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, provider)
);

CREATE OR REPLACE VIEW platform_demo_accounts_safe AS
SELECT id, provider, label, enabled, kill_switch_enabled,
       (api_key_ciphertext <> '') AS has_api_key,
       (secret_ciphertext <> '') AS has_secret,
       (passphrase_ciphertext IS NOT NULL AND passphrase_ciphertext <> '') AS has_passphrase,
       last_verified_at, last_verification_status, created_at, updated_at
FROM platform_demo_accounts;

CREATE TABLE IF NOT EXISTS platform_demo_card_controls (
  provider text NOT NULL CHECK (provider IN ('okx', 'binance', 'bybit')),
  strategy_code text NOT NULL CHECK (strategy_code IN (
    'ai_conservative', 'ai_balanced', 'ai_aggressive'
  )),
  kill_switch_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, strategy_code)
);

CREATE TABLE IF NOT EXISTS platform_demo_order_intents (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('okx', 'binance', 'bybit')),
  strategy_code text NOT NULL CHECK (strategy_code IN (
    'ai_conservative', 'ai_balanced', 'ai_aggressive'
  )),
  decision_round_id text NOT NULL,
  runtime_cycle_id text,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 128),
  client_order_id text NOT NULL UNIQUE CHECK (length(client_order_id) BETWEEN 8 AND 36),
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  quote_amount_usdt numeric(30, 12) NOT NULL CHECK (quote_amount_usdt = 10),
  reference_price numeric(30, 12) NOT NULL CHECK (reference_price > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'accepted', 'unknown', 'retry_wait', 'cancelled', 'failed'
  )),
  provider_order_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, strategy_code, decision_round_id),
  FOREIGN KEY (account_id, provider) REFERENCES platform_demo_accounts(id, provider)
);

CREATE INDEX IF NOT EXISTS idx_platform_demo_intents_queue
  ON platform_demo_order_intents (status, next_attempt_at, lease_expires_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_platform_demo_intents_provider_day
  ON platform_demo_order_intents (provider, created_at);

CREATE OR REPLACE FUNCTION enforce_platform_demo_daily_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used_usdt numeric(30, 12);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'platform-demo-cap:' || NEW.provider || ':' || (NEW.created_at AT TIME ZONE 'UTC')::date::text,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM platform_demo_order_intents
    WHERE provider = NEW.provider
      AND strategy_code = NEW.strategy_code
      AND decision_round_id = NEW.decision_round_id
  ) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(quote_amount_usdt), 0) INTO used_usdt
  FROM platform_demo_order_intents
  WHERE provider = NEW.provider
    AND created_at >= date_trunc('day', NEW.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND created_at < (date_trunc('day', NEW.created_at AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC';
  IF used_usdt + NEW.quote_amount_usdt > 100 THEN
    RAISE EXCEPTION 'platform demo provider daily cap exceeded';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_platform_demo_daily_cap ON platform_demo_order_intents;
CREATE TRIGGER trg_platform_demo_daily_cap
BEFORE INSERT ON platform_demo_order_intents
FOR EACH ROW EXECUTE FUNCTION enforce_platform_demo_daily_cap();

CREATE TABLE IF NOT EXISTS platform_demo_execution_receipts (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES platform_demo_order_intents(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('okx', 'binance', 'bybit')),
  provider_order_id text NOT NULL,
  client_order_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  filled_base_quantity numeric(30, 12) NOT NULL DEFAULT 0 CHECK (filled_base_quantity >= 0),
  filled_quote_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (filled_quote_usdt >= 0),
  fee_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (fee_usdt >= 0),
  observed_at timestamptz NOT NULL,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 128),
  safe_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, provider_order_id, status, observed_at)
);

CREATE OR REPLACE FUNCTION reject_platform_demo_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform demo execution receipts are append-only';
END $$;

DROP TRIGGER IF EXISTS trg_platform_demo_receipts_immutable ON platform_demo_execution_receipts;
CREATE TRIGGER trg_platform_demo_receipts_immutable
BEFORE UPDATE OR DELETE ON platform_demo_execution_receipts
FOR EACH ROW EXECUTE FUNCTION reject_platform_demo_receipt_mutation();
