CREATE TABLE IF NOT EXISTS commercial_plan_versions (
  id text PRIMARY KEY,
  plan_code text NOT NULL CHECK (plan_code IN ('monthly','quarterly','annual','lifetime')),
  version integer NOT NULL CHECK (version > 0),
  price_amount numeric(36,18) NOT NULL CHECK (price_amount > 0),
  price_currency text NOT NULL DEFAULT 'USDT',
  duration_days integer,
  ai_credit_grant numeric(36,0) NOT NULL CHECK (ai_credit_grant > 0),
  performance_fee_bps integer NOT NULL CHECK (performance_fee_bps BETWEEN 0 AND 10000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_code, version),
  CHECK ((plan_code = 'lifetime' AND duration_days IS NULL) OR (plan_code <> 'lifetime' AND duration_days > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_plan_one_active
  ON commercial_plan_versions(plan_code) WHERE status = 'active';

INSERT INTO commercial_plan_versions
  (id, plan_code, version, price_amount, duration_days, ai_credit_grant, performance_fee_bps, effective_at)
VALUES
  ('membership_monthly_v1','monthly',1,28,30,1000,2000,'2026-08-20T00:00:00Z'),
  ('membership_quarterly_v1','quarterly',1,58,90,3000,2000,'2026-08-20T00:00:00Z'),
  ('membership_annual_v1','annual',1,198,365,12000,2000,'2026-08-20T00:00:00Z'),
  ('membership_lifetime_v1','lifetime',1,588,NULL,36000,1600,'2026-08-20T00:00:00Z')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS commercial_legal_document_versions (
  id text PRIMARY KEY,
  document_type text NOT NULL CHECK (document_type IN ('terms','privacy','risk_disclosure')),
  version integer NOT NULL CHECK (version > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_type, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_legal_one_active
  ON commercial_legal_document_versions(document_type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS commercial_legal_acceptances (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_version_id text NOT NULL REFERENCES commercial_legal_document_versions(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  UNIQUE(user_id, document_version_id)
);

CREATE TABLE IF NOT EXISTS commercial_membership_orders (
  id text PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_version_id text NOT NULL REFERENCES commercial_plan_versions(id) ON DELETE RESTRICT,
  price_amount numeric(36,18) NOT NULL CHECK (price_amount > 0),
  price_currency text NOT NULL,
  duration_days integer CHECK (duration_days IS NULL OR duration_days > 0),
  ai_credit_grant numeric(36,0) NOT NULL CHECK (ai_credit_grant > 0),
  performance_fee_bps integer NOT NULL CHECK (performance_fee_bps BETWEEN 0 AND 10000),
  legal_snapshot_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending_evidence' CHECK (status IN ('pending_evidence','pending_review','approved','rejected','cancelled')),
  idempotency_key text NOT NULL,
  request_id text NOT NULL UNIQUE,
  approved_membership_id text REFERENCES memberships(id) ON DELETE RESTRICT,
  ledger_transaction_id text REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  submitted_by_user_id text,
  submitted_at timestamptz,
  reviewed_by_user_id text,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_commercial_orders_queue ON commercial_membership_orders(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS commercial_payment_evidence (
  id text PRIMARY KEY,
  membership_order_id text REFERENCES commercial_membership_orders(id) ON DELETE RESTRICT,
  performance_statement_id text,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('bank_transfer','manual_invoice','provider_reference')),
  provider_label text,
  reference_masked text NOT NULL,
  reference_fingerprint text NOT NULL,
  amount numeric(36,18) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  occurred_at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  recorded_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((membership_order_id IS NOT NULL) <> (performance_statement_id IS NOT NULL)),
  UNIQUE(membership_order_id, reference_fingerprint)
);

CREATE TABLE IF NOT EXISTS commercial_membership_order_decisions (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commercial_membership_orders(id) ON DELETE RESTRICT,
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  note text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS membership_entitlement_events (
  id text PRIMARY KEY,
  membership_id text NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES commercial_membership_orders(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('activated','renewed','expired','revoked')),
  before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_credit_accounts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT UNIQUE,
  available_credits numeric(36,0) NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
  reserved_credits numeric(36,0) NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_credit_reservations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ai_credit_accounts(id) ON DELETE RESTRICT,
  estimated_credits numeric(36,0) NOT NULL CHECK (estimated_credits > 0),
  settled_credits numeric(36,0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released')),
  idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_credit_ledger_entries (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ai_credit_accounts(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('grant','reserve','settle','release','adjust')),
  available_delta numeric(36,0) NOT NULL,
  reserved_delta numeric(36,0) NOT NULL,
  balance_available numeric(36,0) NOT NULL CHECK (balance_available >= 0),
  balance_reserved numeric(36,0) NOT NULL CHECK (balance_reserved >= 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  reservation_id text REFERENCES ai_credit_reservations(id) ON DELETE RESTRICT,
  cost_model_version text,
  usage_json jsonb,
  idempotency_key text NOT NULL UNIQUE,
  request_id text NOT NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available_delta <> 0 OR reserved_delta <> 0),
  UNIQUE(source_type, source_id, entry_type)
);

CREATE OR REPLACE FUNCTION enforce_ai_credit_ledger_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'AI_CREDIT_LEDGER_APPEND_ONLY' USING ERRCODE='integrity_constraint_violation'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_credit_ledger_append_only ON ai_credit_ledger_entries;
CREATE TRIGGER ai_credit_ledger_append_only BEFORE UPDATE OR DELETE ON ai_credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_ai_credit_ledger_append_only();

CREATE TABLE IF NOT EXISTS performance_fee_high_water_marks (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  cumulative_net_pnl numeric(36,18) NOT NULL DEFAULT 0,
  high_water_mark numeric(36,18) NOT NULL DEFAULT 0,
  last_paid_statement_id text,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS performance_fee_statements (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_id text NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  plan_version_id text NOT NULL REFERENCES commercial_plan_versions(id) ON DELETE RESTRICT,
  week_start timestamptz NOT NULL,
  week_end timestamptz NOT NULL,
  strategy_codes_json jsonb NOT NULL,
  week_net_pnl numeric(36,18) NOT NULL,
  cumulative_net_pnl numeric(36,18) NOT NULL,
  prior_high_water_mark numeric(36,18) NOT NULL,
  eligible_profit numeric(36,18) NOT NULL CHECK (eligible_profit >= 0),
  loss_carry numeric(36,18) NOT NULL CHECK (loss_carry >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  fee_amount numeric(36,18) NOT NULL CHECK (fee_amount >= 0),
  currency text NOT NULL DEFAULT 'USDT',
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','no_fee','payment_pending','paid')),
  generated_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (week_end = week_start + interval '7 days'),
  UNIQUE(user_id, week_start, week_end)
);
CREATE INDEX IF NOT EXISTS idx_performance_statements_user_time ON performance_fee_statements(user_id, week_start DESC, id DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_commercial_evidence_statement' AND conrelid='commercial_payment_evidence'::regclass) THEN
    ALTER TABLE commercial_payment_evidence ADD CONSTRAINT fk_commercial_evidence_statement
      FOREIGN KEY (performance_statement_id) REFERENCES performance_fee_statements(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_evidence_statement_fingerprint
  ON commercial_payment_evidence(performance_statement_id, reference_fingerprint)
  WHERE performance_statement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS performance_fee_decisions (
  id text PRIMARY KEY,
  statement_id text NOT NULL REFERENCES performance_fee_statements(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('assessment','payment')),
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  note text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(statement_id, stage, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS performance_fee_receivables (
  id text PRIMARY KEY,
  statement_id text NOT NULL REFERENCES performance_fee_statements(id) ON DELETE RESTRICT UNIQUE,
  amount numeric(36,18) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','waived')),
  payment_evidence_id text REFERENCES commercial_payment_evidence(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE OR REPLACE VIEW commercial_closed_paper_pnl AS
SELECT d.owner_user_id AS user_id, d.strategy_id, p.closed_at, p.realized_net_pnl_usdt
FROM strategy_paper_positions p
JOIN strategy_deployments d ON d.id = p.deployment_id
WHERE d.mode = 'paper' AND p.status = 'closed' AND p.closed_at IS NOT NULL;
