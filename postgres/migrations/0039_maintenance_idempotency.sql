CREATE TABLE IF NOT EXISTS maintenance_idempotency_records (
  id text PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN (
    'maintenance.source_integration.test',
    'maintenance.trading.emergency_stop'
  )),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  subject_type text NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 120),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  canonical_payload_sha256 text NOT NULL CHECK (canonical_payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','succeeded','failed')),
  response_status integer CHECK (response_status BETWEEN 200 AND 599),
  response_json jsonb,
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  request_id text,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  completed_at timestamptz,
  UNIQUE(operation,actor_user_id,idempotency_key_hash),
  CHECK (
    (status='processing' AND response_status IS NULL AND response_json IS NULL AND completed_at IS NULL)
    OR
    (status IN ('succeeded','failed') AND response_status IS NOT NULL AND response_json IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (expires_at > created_at)
);

REVOKE ALL ON maintenance_idempotency_records FROM PUBLIC;

CREATE OR REPLACE FUNCTION protect_maintenance_idempotency_record() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'maintenance idempotency records are immutable';
  END IF;
  IF OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR OLD.idempotency_key_hash IS DISTINCT FROM NEW.idempotency_key_hash
    OR OLD.subject_type IS DISTINCT FROM NEW.subject_type
    OR OLD.subject_id IS DISTINCT FROM NEW.subject_id
    OR OLD.canonical_payload_sha256 IS DISTINCT FROM NEW.canonical_payload_sha256
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.trace_id IS DISTINCT FROM NEW.trace_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'maintenance idempotency identity is immutable';
  END IF;
  IF OLD.status <> 'processing' THEN
    RAISE EXCEPTION 'maintenance idempotency terminal result is immutable';
  END IF;
  IF NEW.status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'maintenance idempotency processing state only permits a terminal transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintenance_idempotency_immutable ON maintenance_idempotency_records;
CREATE TRIGGER trg_maintenance_idempotency_immutable
BEFORE UPDATE OR DELETE ON maintenance_idempotency_records
FOR EACH ROW EXECUTE FUNCTION protect_maintenance_idempotency_record();

CREATE INDEX IF NOT EXISTS idx_maintenance_idempotency_created
  ON maintenance_idempotency_records(created_at DESC,id DESC);

COMMENT ON COLUMN maintenance_idempotency_records.expires_at IS
  'Expired processing claims transition to terminal MAINTENANCE_RECONCILIATION_REQUIRED and are never reopened.';
