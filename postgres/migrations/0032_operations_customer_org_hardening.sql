CREATE TABLE IF NOT EXISTS customer_attribution_change_requests (
  id text PRIMARY KEY,
  request_no text NOT NULL UNIQUE,
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attribution_id text NOT NULL REFERENCES customer_attributions(id) ON DELETE RESTRICT,
  branch_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  previous_assignment_json jsonb NOT NULL,
  proposed_assignment_json jsonb NOT NULL,
  expected_attribution_updated_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  decision_note text,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by_user_id,idempotency_key),
  CHECK(decided_by_user_id IS NULL OR decided_by_user_id<>requested_by_user_id),
  CHECK((status='pending' AND decided_by_user_id IS NULL AND decided_at IS NULL)
     OR (status<>'pending' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attribution_changes_one_pending
  ON customer_attribution_change_requests(attribution_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_attribution_changes_queue
  ON customer_attribution_change_requests(status,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_changes_customer_time
  ON customer_attribution_change_requests(customer_id,requested_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS customer_attribution_change_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES customer_attribution_change_requests(id) ON DELETE RESTRICT UNIQUE,
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approve','reject')),
  note text NOT NULL CHECK(length(note) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
