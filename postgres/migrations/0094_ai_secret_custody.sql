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

CREATE OR REPLACE VIEW maintenance_ai_secret_broker_key_safe
WITH (security_barrier=true)
AS
SELECT key_id,algorithm,public_key_spki_base64,fingerprint_sha256,not_before,not_after
FROM ai_secret_broker_keys
WHERE status='active' AND not_before <= now() AND (not_after IS NULL OR not_after > now());

CREATE OR REPLACE FUNCTION ai_enqueue_secret_command(
  p_id text,p_target_connection_revision_id text,p_broker_key_id text,p_algorithm text,
  p_wrapped_data_key text,p_iv text,p_ciphertext text,p_auth_tag text,p_envelope_digest_sha256 text,
  p_actor_user_id text,p_idempotency_key text,p_reason text,p_request_id text
) RETURNS text AS $$
DECLARE command_id text;
BEGIN
  IF p_algorithm<>'AES-256-GCM+RSA-OAEP-SHA256'
    OR p_envelope_digest_sha256 !~ '^[a-f0-9]{64}$'
    OR length(p_wrapped_data_key) NOT BETWEEN 4 AND 32768
    OR length(p_iv) NOT BETWEEN 4 AND 128
    OR length(p_ciphertext) NOT BETWEEN 4 AND 16384
    OR length(p_auth_tag) NOT BETWEEN 4 AND 128
    OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_SECRET_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ai_connection_revisions WHERE id=p_target_connection_revision_id)
    OR NOT EXISTS(SELECT 1 FROM maintenance_ai_secret_broker_key_safe WHERE key_id=p_broker_key_id)
  THEN RAISE EXCEPTION 'AI_SECRET_COMMAND_TARGET_INVALID' USING ERRCODE='23503'; END IF;
  INSERT INTO ai_secret_commands(
    id,target_connection_revision_id,broker_key_id,algorithm,wrapped_data_key,iv,ciphertext,auth_tag,
    envelope_digest_sha256,requested_by_user_id,idempotency_key
  ) VALUES(
    p_id,p_target_connection_revision_id,p_broker_key_id,p_algorithm,p_wrapped_data_key,p_iv,
    p_ciphertext,p_auth_tag,p_envelope_digest_sha256,p_actor_user_id,p_idempotency_key
  ) ON CONFLICT(requested_by_user_id,idempotency_key) DO UPDATE SET updated_at=ai_secret_commands.updated_at
  RETURNING id INTO command_id;
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-secret-command-' || md5(p_request_id || command_id),p_actor_user_id,
    'maintenance.ai_control_plane.secret_enqueued','ai_secret_command',command_id,
    jsonb_build_object('reason',btrim(p_reason),'targetConnectionRevisionId',p_target_connection_revision_id,
      'brokerKeyId',p_broker_key_id,'envelopeDigestSha256',p_envelope_digest_sha256)::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN command_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON maintenance_ai_secret_broker_key_safe FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_enqueue_secret_command(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON maintenance_ai_secret_broker_key_safe TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_enqueue_secret_command(text,text,text,text,text,text,text,text,text,text,text,text,text)
      TO agentnovas_maint_web;
  END IF;
END $$;

REVOKE ALL ON ai_secret_broker_keys,ai_secret_commands,ai_secret_receipts,ai_legacy_secret_migration_receipts FROM PUBLIC;
