-- Complete the Udun deposit-only management boundary. Provider credentials remain
-- ciphertext in PostgreSQL and are decrypted only by the Payment Secret Broker.

ALTER TABLE payment_provider_configs
  ADD COLUMN secret_configuration_version text,
  ADD COLUMN secret_configuration_fingerprint text CHECK (
    secret_configuration_fingerprint IS NULL OR secret_configuration_fingerprint ~ '^[a-f0-9]{16}$'
  ),
  ADD COLUMN last_test_configuration_version text,
  ADD COLUMN last_callback_test_at timestamptz,
  ADD COLUMN last_callback_test_status text CHECK (
    last_callback_test_status IS NULL OR last_callback_test_status IN ('passed','failed')
  ),
  ADD COLUMN last_callback_test_configuration_version text,
  ADD COLUMN last_callback_error_code text;

ALTER TABLE deposit_orders
  DROP CONSTRAINT IF EXISTS deposit_orders_order_status_check;
ALTER TABLE deposit_orders
  ADD CONSTRAINT deposit_orders_order_status_check CHECK (order_status IN (
    'ADDRESS_PROVISIONING','ADDRESS_UNKNOWN','ADDRESS_FAILED',
    'PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW','CREDITED','FAILED','RETURNED'
  ));

DROP INDEX IF EXISTS idx_deposit_orders_one_open_udun_order;
CREATE UNIQUE INDEX idx_deposit_orders_one_open_udun_order
  ON deposit_orders(user_id,provider,network)
  WHERE provider='udun' AND order_status IN (
    'ADDRESS_PROVISIONING','ADDRESS_UNKNOWN','PENDING_CONFIRMATION','CONFIRMING','MANUAL_REVIEW'
  );

CREATE OR REPLACE VIEW client_payment_provider_configs_safe AS
SELECT id,provider,channel,network,status,confirmation_threshold,
  jsonb_build_object(
    'protocol',settings_json->>'protocol',
    'mainCoinType',settings_json->>'mainCoinType',
    'tokenCoinType',settings_json->>'tokenCoinType',
    'walletId',settings_json->>'walletId'
  ) AS settings_json,
  secret_configuration_version,
  last_test_at,last_test_status,last_test_configuration_version,
  last_callback_test_at,last_callback_test_status,last_callback_test_configuration_version
FROM payment_provider_configs
WHERE provider='udun' AND channel='on_chain';

CREATE TABLE payment_secret_requests (
  id text PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('install','rotate')),
  key_id text NOT NULL CHECK (
    length(key_id) BETWEEN 8 AND 80 AND key_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  envelope_json jsonb NOT NULL CHECK (
    jsonb_typeof(envelope_json)='object'
    AND envelope_json->>'version'='v1'
    AND envelope_json->>'keyId'=key_id
    AND envelope_json ?& ARRAY['version','keyId','wrappedKey','iv','ciphertext']
    AND envelope_json - ARRAY['version','keyId','wrappedKey','iv','ciphertext'] = '{}'::jsonb
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','applying','applied','failed','superseded')
  ),
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  request_id text,
  trace_id text,
  claimed_by text,
  lease_expires_at timestamptz,
  configuration_version text,
  configuration_fingerprint text CHECK (
    configuration_fingerprint IS NULL OR configuration_fingerprint ~ '^[a-f0-9]{16}$'
  ),
  error_code text CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 80 AND error_code ~ '^[A-Z0-9_:-]+$'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status='pending' AND claimed_by IS NULL AND lease_expires_at IS NULL AND applied_at IS NULL AND failed_at IS NULL)
    OR (status='applying' AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL AND applied_at IS NULL AND failed_at IS NULL)
    OR (status='applied' AND claimed_by IS NOT NULL AND applied_at IS NOT NULL AND failed_at IS NULL AND error_code IS NULL)
    OR (status='failed' AND claimed_by IS NOT NULL AND applied_at IS NULL AND failed_at IS NOT NULL AND error_code IS NOT NULL)
    OR (status='superseded' AND applied_at IS NULL)
  )
);

CREATE INDEX idx_payment_secret_requests_claim
  ON payment_secret_requests(status,created_at,id)
  WHERE status IN ('pending','applying');

CREATE TABLE payment_secret_broker_heartbeats (
  instance_id text PRIMARY KEY CHECK (length(instance_id) BETWEEN 3 AND 160),
  status text NOT NULL CHECK (status IN ('starting','running','stopping','stopped','error')),
  commit_sha text,
  current_request_id text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 80 AND last_error_code ~ '^[A-Z0-9_:-]+$'
    )
  ),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_secret_broker_heartbeat
  ON payment_secret_broker_heartbeats(heartbeat_at DESC);

-- The Client role only receives this safe projection. Broker liveness is reduced
-- to one boolean so the Client server can fail closed without reading broker rows.
CREATE OR REPLACE VIEW client_payment_provider_configs_safe AS
SELECT id,provider,channel,network,status,confirmation_threshold,
  jsonb_build_object(
    'protocol',settings_json->>'protocol',
    'mainCoinType',settings_json->>'mainCoinType',
    'tokenCoinType',settings_json->>'tokenCoinType',
    'walletId',settings_json->>'walletId'
  ) AS settings_json,
  secret_configuration_version,
  last_test_at,last_test_status,last_test_configuration_version,
  last_callback_test_at,last_callback_test_status,last_callback_test_configuration_version,
  EXISTS (
    SELECT 1 FROM payment_secret_broker_heartbeats AS heartbeat
    WHERE heartbeat.status='running' AND heartbeat.heartbeat_at >= now() - interval '90 seconds'
  ) AS broker_available
FROM payment_provider_configs
WHERE provider='udun' AND channel='on_chain';

CREATE TABLE payment_provider_test_runs (
  id text PRIMARY KEY,
  provider_config_id text NOT NULL REFERENCES payment_provider_configs(id) ON DELETE RESTRICT,
  test_kind text NOT NULL CHECK (test_kind IN ('provider_connectivity','callback_readiness')),
  status text NOT NULL CHECK (status IN ('passed','failed')),
  configuration_version text NOT NULL,
  error_code text CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 80 AND error_code ~ '^[A-Z0-9_:-]+$'
    )
  ),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  request_id text,
  trace_id text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CHECK (completed_at >= started_at),
  CHECK ((status='passed' AND error_code IS NULL) OR (status='failed' AND error_code IS NOT NULL))
);

CREATE INDEX idx_payment_provider_test_runs_history
  ON payment_provider_test_runs(provider_config_id,completed_at DESC,id DESC);

CREATE OR REPLACE FUNCTION enforce_payment_provider_test_runs_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAYMENT_PROVIDER_TEST_RUN_APPEND_ONLY' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_provider_test_runs_append_only ON payment_provider_test_runs;
CREATE TRIGGER trg_payment_provider_test_runs_append_only
  BEFORE UPDATE OR DELETE ON payment_provider_test_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_provider_test_runs_append_only();

ALTER TABLE maintenance_idempotency_records
  DROP CONSTRAINT IF EXISTS maintenance_idempotency_records_operation_check;
ALTER TABLE maintenance_idempotency_records
  ADD CONSTRAINT maintenance_idempotency_records_operation_check CHECK (operation IN (
    'maintenance.source_integration.test',
    'maintenance.trading.emergency_stop',
    'maintenance.work_records.export',
    'maintenance.email_configuration.update',
    'maintenance.email_recipient.create',
    'maintenance.email_recipient.verify',
    'maintenance.email_recipient.update',
    'maintenance.email_recipient.delete',
    'maintenance.email_secret.request',
    'maintenance.payment_secret.request',
    'maintenance.payment_provider.configuration',
    'maintenance.payment_provider.status',
    'maintenance.payment_provider.test',
    'maintenance.payment_provider.callback_test'
  ));

INSERT INTO authorization_audit_events(
  id,application_id,actor_user_id,action,subject_type,subject_id,after_json
) VALUES (
  'audit-0092-udun-service-completion',
  'maintenance',
  NULL,
  'payment_provider.udun_service_completion_created',
  'payment_provider_config',
  'udun-usdt-trc20',
  '{"defaultStatus":"disabled","withdrawals":false,"autoCredit":false,"secretSource":"payment_secret_broker","callbackContentType":"application/x-www-form-urlencoded"}'::jsonb
) ON CONFLICT(id) DO NOTHING;
