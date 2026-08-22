CREATE TABLE IF NOT EXISTS ai_credit_adjustment_requests (
  id text PRIMARY KEY,
  request_no text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id text REFERENCES ai_credit_accounts(id) ON DELETE RESTRICT,
  amount_delta numeric(36,0) NOT NULL CHECK(amount_delta<>0),
  reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  evidence_reference text NOT NULL DEFAULT '' CHECK(length(evidence_reference)<=500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  idempotency_key text NOT NULL,
  decided_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  decision_note text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by_user_id,idempotency_key),
  CHECK((status='pending' AND decided_by_user_id IS NULL AND decided_at IS NULL)
     OR (status<>'pending' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK(decided_by_user_id IS NULL OR decided_by_user_id<>requested_by_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_adjustments_one_pending_user
  ON ai_credit_adjustment_requests(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_credit_adjustments_queue
  ON ai_credit_adjustment_requests(status,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_credit_adjustments_user_time
  ON ai_credit_adjustment_requests(user_id,requested_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS ai_credit_adjustment_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES ai_credit_adjustment_requests(id) ON DELETE RESTRICT UNIQUE,
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approve','reject')),
  note text NOT NULL CHECK(length(note) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO permission_definitions(key,application_id,label,sensitive)
VALUES
  ('ops.credits.adjust','operations','发起客户积分调整',true),
  ('ops.credits.approve','operations','审批客户积分调整',true)
ON CONFLICT(key) DO UPDATE SET application_id=EXCLUDED.application_id,label=EXCLUDED.label,sensitive=true;
