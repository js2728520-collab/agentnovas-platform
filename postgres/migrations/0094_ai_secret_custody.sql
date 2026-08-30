-- Envelope-encrypted secret command queue. Only the dedicated Broker may decrypt.

CREATE TABLE IF NOT EXISTS ai_secret_broker_keys (
  key_id text PRIMARY KEY,
  algorithm text NOT NULL DEFAULT 'RSA-OAEP-SHA256' CHECK (algorithm='RSA-OAEP-SHA256'),
  public_key_spki_base64 text NOT NULL,
  fingerprint_sha256 text NOT NULL UNIQUE CHECK (fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retiring','retired')),
  not_before timestamptz NOT NULL,
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (not_after IS NULL OR not_after > not_before)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_secret_broker_one_active_key
  ON ai_secret_broker_keys((status)) WHERE status='active';

CREATE TABLE IF NOT EXISTS ai_secret_commands (
  id text PRIMARY KEY,
  target_connection_revision_id text NOT NULL REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  broker_key_id text NOT NULL REFERENCES ai_secret_broker_keys(key_id) ON DELETE RESTRICT,
  algorithm text NOT NULL DEFAULT 'AES-256-GCM+RSA-OAEP-SHA256'
    CHECK (algorithm='AES-256-GCM+RSA-OAEP-SHA256'),
  wrapped_data_key text,
  iv text,
  ciphertext text,
  auth_tag text,
  envelope_digest_sha256 text NOT NULL CHECK (envelope_digest_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','processing','succeeded','failed')),
  requested_by_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  secret_ref text,
  secret_fingerprint text,
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by_user_id,idempotency_key),
  CHECK (
    (status='succeeded' AND wrapped_data_key IS NULL AND iv IS NULL AND ciphertext IS NULL AND auth_tag IS NULL
      AND secret_ref IS NOT NULL AND secret_fingerprint IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status<>'succeeded' AND wrapped_data_key IS NOT NULL AND iv IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL
      AND secret_ref IS NULL AND secret_fingerprint IS NULL)
  ),
  CHECK (secret_ref IS NULL OR secret_ref ~ '^managed://[A-Za-z0-9._:/-]+$'),
  CHECK (secret_fingerprint IS NULL OR secret_fingerprint ~ '^[a-f0-9]{12,64}$')
);

CREATE INDEX IF NOT EXISTS idx_ai_secret_commands_queue
  ON ai_secret_commands(status,lease_expires_at,requested_at);

CREATE TABLE IF NOT EXISTS ai_secret_receipts (
  id text PRIMARY KEY,
  command_id text NOT NULL UNIQUE REFERENCES ai_secret_commands(id) ON DELETE RESTRICT,
  target_connection_revision_id text NOT NULL REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  broker_key_id text NOT NULL REFERENCES ai_secret_broker_keys(key_id) ON DELETE RESTRICT,
  envelope_digest_sha256 text NOT NULL CHECK (envelope_digest_sha256 ~ '^[a-f0-9]{64}$'),
  secret_ref text NOT NULL CHECK (secret_ref ~ '^managed://[A-Za-z0-9._:/-]+$'),
  secret_fingerprint text NOT NULL CHECK (secret_fingerprint ~ '^[a-f0-9]{12,64}$'),
  file_mode text NOT NULL DEFAULT '0600' CHECK (file_mode='0600'),
  directory_mode text NOT NULL DEFAULT '0700' CHECK (directory_mode='0700'),
  broker_instance_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_legacy_secret_migration_receipts (
  id text PRIMARY KEY,
  legacy_profile_revision_id text NOT NULL UNIQUE REFERENCES llm_profile_revisions(id) ON DELETE RESTRICT,
  target_connection_revision_id text NOT NULL UNIQUE REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('succeeded','failed')),
  secret_ref text,
  secret_fingerprint text,
  error_code text,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status='succeeded' AND secret_ref IS NOT NULL AND secret_fingerprint IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND secret_ref IS NULL AND secret_fingerprint IS NULL AND error_code IS NOT NULL)
  )
);

COMMENT ON TABLE ai_secret_commands IS
  'Web-visible queue of envelope ciphertext only. Successful rows erase all encrypted command material and retain a managed reference.';
COMMENT ON TABLE ai_secret_receipts IS
  'Non-secret custody evidence produced only after an atomic 0700-directory/0600-file write.';

REVOKE ALL ON ai_secret_broker_keys,ai_secret_commands,ai_secret_receipts,ai_legacy_secret_migration_receipts FROM PUBLIC;
