-- Email service management v2: independently verified test recipients and a
-- ciphertext-only handoff to the least-privilege Email Secret Broker.

ALTER TABLE notification_email_test_recipients
  DROP CONSTRAINT IF EXISTS notification_email_test_recipients_status_check;
ALTER TABLE notification_email_test_recipients
  DROP CONSTRAINT IF EXISTS notification_email_test_recipients_check;

ALTER TABLE notification_email_test_recipients
  ADD COLUMN id text,
  ADD COLUMN recipient_ciphertext text,
  ADD COLUMN recipient_mask text,
  ADD COLUMN label text,
  ADD COLUMN verification_code_hash text,
  ADD COLUMN verification_expires_at timestamptz,
  ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_sent_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1;

-- ADR-0025 rows contain only an irreversible hash, so they cannot safely be
-- promoted into the v2 address book. Preserve the audit fact as a tombstone.
UPDATE notification_email_test_recipients
   SET id='legacy-' || substring(recipient_hash,1,32),
       recipient_mask='迁移前地址（不可恢复）',
       label='迁移前测试地址',
       status='deleted',
       deleted_at=COALESCE(revoked_at,updated_at,now()),
       revoked_at=COALESCE(revoked_at,updated_at,now());

ALTER TABLE notification_email_test_recipients
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN recipient_mask SET NOT NULL,
  ALTER COLUMN label SET NOT NULL;

ALTER TABLE notification_email_test_recipients
  DROP CONSTRAINT notification_email_test_recipients_pkey;
ALTER TABLE notification_email_test_recipients
  ADD CONSTRAINT notification_email_test_recipients_pkey PRIMARY KEY(id),
  ADD CONSTRAINT notification_email_test_recipients_recipient_hash_unique UNIQUE(recipient_hash),
  ADD CONSTRAINT notification_email_test_recipients_status_check CHECK (
    status IN ('pending_verification','active','disabled','deleted')
  ),
  ADD CONSTRAINT notification_email_test_recipients_label_check CHECK (
    length(label) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT notification_email_test_recipients_mask_check CHECK (
    length(recipient_mask) BETWEEN 3 AND 320
  ),
  ADD CONSTRAINT notification_email_test_recipients_verification_attempts_check CHECK (
    verification_attempts BETWEEN 0 AND 5
  ),
  ADD CONSTRAINT notification_email_test_recipients_version_check CHECK (version > 0),
  ADD CONSTRAINT notification_email_test_recipients_lifecycle_check CHECK (
    (
      status='pending_verification'
      AND recipient_ciphertext IS NOT NULL
      AND verification_code_hash ~ '^[a-f0-9]{64}$'
      AND verification_expires_at IS NOT NULL
      AND verification_sent_at IS NOT NULL
      AND verified_at IS NULL
      AND deleted_at IS NULL
    ) OR (
      status IN ('active','disabled')
      AND recipient_ciphertext IS NOT NULL
      AND verification_code_hash IS NULL
      AND verification_expires_at IS NULL
      AND verified_at IS NOT NULL
      AND deleted_at IS NULL
    ) OR (
      status='deleted'
      AND verification_code_hash IS NULL
      AND verification_expires_at IS NULL
      AND deleted_at IS NOT NULL
    )
  );

DROP INDEX IF EXISTS idx_notification_email_test_recipients_status;
CREATE INDEX idx_notification_email_test_recipients_status
  ON notification_email_test_recipients(status,updated_at DESC,id);
CREATE INDEX idx_notification_email_test_recipients_verification_expiry
  ON notification_email_test_recipients(verification_expires_at)
  WHERE status='pending_verification';

ALTER TABLE notification_deliveries
  ADD COLUMN test_recipient_id text REFERENCES notification_email_test_recipients(id) ON DELETE RESTRICT;

CREATE INDEX idx_notification_deliveries_test_recipient
  ON notification_deliveries(test_recipient_id,created_at DESC)
  WHERE test_recipient_id IS NOT NULL;

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_secret_metadata_check;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_secret_metadata_check CHECK (
    (secret_kind IS NULL AND secret_expires_at IS NULL)
    OR (
      secret_kind=template_key
      AND secret_kind IN (
        'verify_email','reset_password','internal_account_invite',
        'maintenance_email_recipient_verification'
      )
      AND secret_expires_at IS NOT NULL
    )
  );

CREATE TABLE notification_email_secret_requests (
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

CREATE INDEX idx_notification_email_secret_requests_claim
  ON notification_email_secret_requests(status,created_at,id)
  WHERE status IN ('pending','applying');

CREATE TABLE notification_email_secret_broker_heartbeats (
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

CREATE INDEX idx_notification_email_secret_broker_heartbeat
  ON notification_email_secret_broker_heartbeats(heartbeat_at DESC);

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
    'maintenance.email_secret.request'
  ));
