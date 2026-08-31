CREATE TABLE notification_email_test_recipients (
  recipient_hash text PRIMARY KEY CHECK (recipient_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_notification_email_test_recipients_status
  ON notification_email_test_recipients(status,updated_at DESC);

ALTER TABLE maintenance_idempotency_records
  DROP CONSTRAINT IF EXISTS maintenance_idempotency_records_operation_check;
ALTER TABLE maintenance_idempotency_records
  ADD CONSTRAINT maintenance_idempotency_records_operation_check CHECK (operation IN (
    'maintenance.source_integration.test',
    'maintenance.trading.emergency_stop',
    'maintenance.work_records.export',
    'maintenance.email_configuration.update'
  ));
