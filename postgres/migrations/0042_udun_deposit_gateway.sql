-- Udun deposit-only gateway. Secrets remain in runtime secret storage; this migration
-- records only non-secret routing metadata and immutable provider evidence.

ALTER TABLE deposit_orders
  ADD COLUMN IF NOT EXISTS provider_config_id text REFERENCES payment_provider_configs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_id text;

ALTER TABLE payment_provider_configs
  ADD COLUMN IF NOT EXISTS last_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_status text CHECK (last_test_status IS NULL OR last_test_status IN ('passed','failed')),
  ADD COLUMN IF NOT EXISTS last_error_code text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_orders_user_idempotency
  ON deposit_orders(user_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_orders_one_open_udun_order
  ON deposit_orders(user_id,provider,network)
  WHERE provider='udun'
    AND order_status IN ('PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deposit_orders
    WHERE provider IS NOT NULL AND deposit_address IS NOT NULL
    GROUP BY provider,network,deposit_address HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'DEPOSIT_ADDRESS_MAPPING_NOT_UNIQUE';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_orders_provider_address_unique
  ON deposit_orders(provider,network,deposit_address)
  WHERE provider IS NOT NULL AND deposit_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS deposit_provider_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_config_id text REFERENCES payment_provider_configs(id) ON DELETE RESTRICT,
  deposit_order_id text REFERENCES deposit_orders(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('deposit_callback')),
  outcome text NOT NULL CHECK (outcome IN ('ignored','manual_review','rejected')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  nonce_sha256 text NOT NULL CHECK (nonce_sha256 ~ '^[a-f0-9]{64}$'),
  provider_timestamp_ms bigint NOT NULL,
  tx_id text,
  deposit_address text,
  amount numeric(36,18),
  status_code integer,
  error_code text,
  request_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_event_id),
  UNIQUE(provider,nonce_sha256)
);

CREATE INDEX IF NOT EXISTS idx_deposit_provider_events_order_time
  ON deposit_provider_events(deposit_order_id,received_at DESC);

DROP TRIGGER IF EXISTS deposit_provider_events_append_only ON deposit_provider_events;
CREATE TRIGGER deposit_provider_events_append_only
  BEFORE UPDATE OR DELETE ON deposit_provider_events
  FOR EACH ROW EXECUTE FUNCTION enforce_ledger_append_only();

INSERT INTO payment_provider_configs(
  id,provider,channel,network,status,confirmation_threshold,settings_json,encrypted_secret_ref
) VALUES (
  'udun-usdt-trc20',
  'udun',
  'on_chain',
  'TRC20',
  'disabled',
  1,
  '{"protocol":"legacy_md5","asset":"USDT","mainCoinType":"195","tokenCoinType":"","walletId":null}'::jsonb,
  NULL
) ON CONFLICT(provider,channel,network) DO NOTHING;

CREATE OR REPLACE VIEW client_payment_provider_configs_safe AS
SELECT id,provider,channel,network,status,confirmation_threshold,
  jsonb_build_object(
    'protocol',settings_json->>'protocol',
    'mainCoinType',settings_json->>'mainCoinType',
    'tokenCoinType',settings_json->>'tokenCoinType',
    'walletId',settings_json->>'walletId'
  ) AS settings_json
FROM payment_provider_configs
WHERE provider='udun' AND channel='on_chain';

CREATE OR REPLACE VIEW payment_webhook_provider_configs_safe AS
SELECT id,provider,
  jsonb_build_object(
    'mainCoinType',settings_json->>'mainCoinType',
    'tokenCoinType',settings_json->>'tokenCoinType'
  ) AS settings_json
FROM payment_provider_configs
WHERE provider='udun' AND channel='on_chain';

INSERT INTO authorization_audit_events(
  id,application_id,actor_user_id,action,subject_type,subject_id,after_json
) VALUES (
  'audit-0042-udun-deposit-boundary',
  'maintenance',
  NULL,
  'payment_provider.udun_deposit_boundary_created',
  'payment_provider_config',
  'udun-usdt-trc20',
  '{"defaultStatus":"disabled","withdrawals":false,"autoCredit":false,"secretSource":"runtime_env"}'::jsonb
) ON CONFLICT(id) DO NOTHING;
