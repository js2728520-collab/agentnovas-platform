-- T8.1b establishes database facts and internal projections only. It does not
-- create a dispatch-capable process, credential, route, or enabled runtime.

CREATE TABLE release_workflow_commands (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  action text NOT NULL CHECK (action IN ('deploy','rollback')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  maker_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  canonical_payload_sha256 text NOT NULL CHECK (canonical_payload_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text) BETWEEN 2 AND 65536
  ),
  artifact_manifest_sha256 text NOT NULL CHECK (artifact_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[a-f0-9]{64}$'),
  environment_generation bigint NOT NULL CHECK (environment_generation > 0),
  expected_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(maker_user_id,idempotency_key)
);

CREATE TABLE release_workflow_approvals (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  command_id text NOT NULL UNIQUE REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  checker_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);

CREATE TABLE release_workflow_activations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  g7_manifest_sha256 text NOT NULL CHECK (g7_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  provider_binding_sha256 text NOT NULL CHECK (provider_binding_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_manifest_sha256 text NOT NULL CHECK (artifact_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[a-f0-9]{64}$'),
  environment_policy_sha256 text NOT NULL CHECK (environment_policy_sha256 ~ '^[a-f0-9]{64}$'),
  runner_policy_sha256 text NOT NULL CHECK (runner_policy_sha256 ~ '^[a-f0-9]{64}$'),
  target_binding_sha256 text NOT NULL CHECK (target_binding_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_trust_sha256 text NOT NULL CHECK (receipt_trust_sha256 ~ '^[a-f0-9]{64}$'),
  auditor_trust_sha256 text NOT NULL CHECK (auditor_trust_sha256 ~ '^[a-f0-9]{64}$'),
  reviewer_allowlist_sha256 text NOT NULL CHECK (reviewer_allowlist_sha256 ~ '^[a-f0-9]{64}$'),
  security_approver_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  release_approver_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (security_approver_user_id <> release_approver_user_id),
  CHECK (expires_at > created_at)
);

CREATE TABLE release_workflow_first_production_enablements (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  activation_id text NOT NULL REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recent_mfa_evidence_sha256 text NOT NULL CHECK (recent_mfa_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  g7_manifest_sha256 text NOT NULL CHECK (g7_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  provider_binding_sha256 text NOT NULL CHECK (provider_binding_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[a-f0-9]{64}$'),
  target_binding_sha256 text NOT NULL CHECK (target_binding_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_trust_sha256 text NOT NULL CHECK (receipt_trust_sha256 ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);

CREATE TABLE release_workflow_environment_generations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  generation bigint NOT NULL CHECK (generation > 0),
  expected_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  actor_kind text NOT NULL CHECK (actor_kind IN ('system','user','target','break_glass')),
  actor_identity text NOT NULL CHECK (length(actor_identity) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(environment,generation)
);

CREATE TABLE release_workflow_attempts (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  attempt_key text NOT NULL CHECK (attempt_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  command_id text NOT NULL REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  activation_id text NOT NULL REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  fact_kind text NOT NULL CHECK (fact_kind IN ('leased','run_bound','dispatch_unknown','released')),
  lease_owner text NOT NULL CHECK (length(lease_owner) BETWEEN 3 AND 160),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  environment_generation bigint NOT NULL CHECK (environment_generation > 0),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz NOT NULL,
  provider_run_id text CHECK (provider_run_id IS NULL OR provider_run_id ~ '^[1-9][0-9]{0,19}$'),
  provider_run_attempt integer CHECK (provider_run_attempt IS NULL OR provider_run_attempt=1),
  provider_run_url text CHECK (
    provider_run_url IS NULL OR (length(provider_run_url) BETWEEN 10 AND 500 AND provider_run_url ~ '^https://')
  ),
  dispatch_request_sha256 text CHECK (
    dispatch_request_sha256 IS NULL OR dispatch_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lease_expires_at > created_at),
  UNIQUE(attempt_key,fact_kind)
);

CREATE TABLE release_workflow_run_policy_attestations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[1-9][0-9]{0,19}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]{0,19}$'),
  run_attempt integer NOT NULL CHECK (run_attempt=1),
  job_id text NOT NULL CHECK (job_id ~ '^[1-9][0-9]{0,19}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  environment_policy_sha256 text NOT NULL CHECK (environment_policy_sha256 ~ '^[a-f0-9]{64}$'),
  runner_policy_sha256 text NOT NULL CHECK (runner_policy_sha256 ~ '^[a-f0-9]{64}$'),
  review_evidence_sha256 text NOT NULL CHECK (review_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  oidc_jti_sha256 text NOT NULL CHECK (oidc_jti_sha256 ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL UNIQUE CHECK (length(nonce) BETWEEN 8 AND 160),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 3 AND 160),
  signature text NOT NULL CHECK (length(signature) BETWEEN 8 AND 512),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at),
  UNIQUE(run_id,run_attempt,job_id,oidc_jti_sha256)
);

CREATE TABLE release_workflow_authorizations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  command_id text NOT NULL REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  attempt_key text NOT NULL,
  attestation_id text NOT NULL UNIQUE REFERENCES release_workflow_run_policy_attestations(id) ON DELETE RESTRICT,
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]{0,19}$'),
  run_attempt integer NOT NULL CHECK (run_attempt=1),
  oidc_jti_sha256 text NOT NULL UNIQUE CHECK (oidc_jti_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_nonce text NOT NULL UNIQUE CHECK (length(authorization_nonce) BETWEEN 8 AND 160),
  operation_id text NOT NULL UNIQUE CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at),
  UNIQUE(command_id,attempt_key)
);

CREATE TABLE release_workflow_target_operations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  authorization_id text NOT NULL UNIQUE REFERENCES release_workflow_authorizations(id) ON DELETE RESTRICT,
  command_id text NOT NULL UNIQUE REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  action text NOT NULL CHECK (action IN ('deploy','rollback')),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_manifest_sha256 text NOT NULL CHECK (artifact_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[a-f0-9]{64}$'),
  environment_generation bigint NOT NULL CHECK (environment_generation > 0),
  expected_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  worker_fencing_token bigint NOT NULL CHECK (worker_fencing_token > 0),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_target_owner_epochs (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  operation_id text NOT NULL REFERENCES release_workflow_target_operations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  previous_owner_epoch bigint CHECK (previous_owner_epoch IS NULL OR previous_owner_epoch > 0),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  owner_identity_sha256 text NOT NULL CHECK (owner_identity_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operation_id,owner_epoch),
  CHECK (
    (owner_epoch=1 AND previous_owner_epoch IS NULL)
    OR (owner_epoch>1 AND previous_owner_epoch=owner_epoch-1)
  )
);

CREATE TABLE release_workflow_events (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  command_id text NOT NULL REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  attempt_key text,
  source text NOT NULL CHECK (source IN ('web','worker','provider','auditor','target','system')),
  kind text NOT NULL CHECK (length(kind) BETWEEN 3 AND 80 AND kind ~ '^[a-z0-9_]+$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata_json)='object' AND octet_length(metadata_json::text) <= 8192
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_deliveries (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 160),
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 3 AND 80),
  action text NOT NULL CHECK (length(action) BETWEEN 2 AND 80),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[1-9][0-9]{0,19}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]{0,19}$'),
  run_attempt integer NOT NULL CHECK (run_attempt > 0),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  head_ref text NOT NULL CHECK (length(head_ref) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('queued','in_progress','completed','unknown')),
  conclusion text CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','timed_out','unknown')),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  payload_size_bytes integer NOT NULL CHECK (payload_size_bytes BETWEEN 2 AND 1048576),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_receipts (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  operation_id text NOT NULL REFERENCES release_workflow_target_operations(id) ON DELETE RESTRICT,
  command_id text NOT NULL REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  receipt_nonce text NOT NULL UNIQUE CHECK (length(receipt_nonce) BETWEEN 8 AND 160),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 3 AND 160),
  payload_json jsonb NOT NULL CHECK (
    jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text) BETWEEN 2 AND 65536
  ),
  payload_sha256 text NOT NULL UNIQUE CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL CHECK (length(signature) BETWEEN 8 AND 512),
  phase text NOT NULL CHECK (phase IN (
    'failed_before_cutover','uncertain_before_cutover','cutover_committed','health_verified',
    'health_failed_after_cutover','uncertain_after_cutover','stop_committed'
  )),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  journal_sequence bigint NOT NULL CHECK (journal_sequence > 0),
  actual_previous_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  actual_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  signature_verified boolean NOT NULL CHECK (signature_verified=true),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operation_id,journal_sequence)
);

CREATE TABLE release_workflow_stop_receipts (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  stop_id text NOT NULL CHECK (stop_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  generation bigint NOT NULL CHECK (generation > 0),
  phase text NOT NULL CHECK (phase IN ('stop_committed','clear_acknowledged')),
  activation_id text REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  expected_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  receipt_nonce text NOT NULL UNIQUE CHECK (length(receipt_nonce) BETWEEN 8 AND 160),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 3 AND 160),
  payload_json jsonb NOT NULL CHECK (
    jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text) BETWEEN 2 AND 65536
  ),
  payload_sha256 text NOT NULL UNIQUE CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL CHECK (length(signature) BETWEEN 8 AND 512),
  actor_kind text NOT NULL CHECK (actor_kind IN ('target','break_glass')),
  actor_fingerprint_sha256 text NOT NULL CHECK (actor_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  signature_verified boolean NOT NULL CHECK (signature_verified=true),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (phase='stop_committed' AND activation_id IS NULL)
    OR (phase='clear_acknowledged' AND activation_id IS NOT NULL)
  ),
  UNIQUE(stop_id,phase)
);

CREATE TABLE release_workflow_stops (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  action text NOT NULL CHECK (action IN ('requested','committed','cleared')),
  generation bigint NOT NULL CHECK (generation > 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','target','break_glass')),
  actor_identity text NOT NULL CHECK (length(actor_identity) BETWEEN 3 AND 160),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  activation_id text REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  receipt_id text REFERENCES release_workflow_receipts(id) ON DELETE RESTRICT,
  stop_receipt_id text REFERENCES release_workflow_stop_receipts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((action='cleared' AND activation_id IS NOT NULL) OR (action<>'cleared' AND activation_id IS NULL)),
  CHECK ((action='committed' AND stop_receipt_id IS NOT NULL) OR (action<>'committed' AND stop_receipt_id IS NULL))
);

CREATE TABLE release_workflow_command_states (
  command_id text PRIMARY KEY REFERENCES release_workflow_commands(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN (
    'requested','approved','leased','dispatching','dispatch_accepted','waiting_authorization','running','settling',
    'succeeded','failed','cancelled','rejected','expired','manual_intervention','deployed_reconciliation_required'
  )),
  current_attempt_key text,
  dispatch_outcome_unknown boolean NOT NULL DEFAULT false,
  provider_state_unknown boolean NOT NULL DEFAULT false,
  receipt_missing boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_environment_states (
  environment text PRIMARY KEY CHECK (environment IN ('staging','production')),
  generation bigint NOT NULL CHECK (generation > 0),
  active_attempt_key text,
  active_operation_id text REFERENCES release_workflow_target_operations(id) ON DELETE RESTRICT,
  target_owner_epoch bigint CHECK (target_owner_epoch IS NULL OR target_owner_epoch > 0),
  expected_current_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  stop_requested boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIEW release_workflow_safe_status WITH (security_barrier=true) AS
SELECT
  command.id AS command_id,
  command.release_version_id,
  command.environment,
  command.action,
  command.reason,
  command.maker_user_id,
  command.environment_generation,
  command.expected_current_release_version_id,
  command.created_at,
  state.status,
  state.dispatch_outcome_unknown,
  state.provider_state_unknown,
  state.receipt_missing,
  state.updated_at
FROM release_workflow_commands AS command
JOIN release_workflow_command_states AS state ON state.command_id=command.id;

REVOKE ALL ON release_workflow_safe_status FROM PUBLIC;

INSERT INTO release_workflow_environment_states(environment,generation)
VALUES ('staging',1),('production',1);

INSERT INTO release_workflow_environment_generations(
  id,environment,generation,reason,actor_kind,actor_identity
) VALUES
  ('release-generation-staging-1','staging',1,'Initial restricted release environment generation','system','migration-0077'),
  ('release-generation-production-1','production',1,'Initial restricted release environment generation','system','migration-0077');

CREATE INDEX idx_release_workflow_commands_environment_created
  ON release_workflow_commands(environment,created_at,id);
CREATE INDEX idx_release_workflow_attempts_command
  ON release_workflow_attempts(command_id,attempt_key,created_at);
CREATE UNIQUE INDEX idx_release_workflow_attempts_bound_run
  ON release_workflow_attempts(provider_run_id,provider_run_attempt)
  WHERE fact_kind='run_bound';
CREATE INDEX idx_release_workflow_events_command_sequence
  ON release_workflow_events(command_id,sequence_no);
CREATE INDEX idx_release_workflow_deliveries_run
  ON release_workflow_deliveries(run_id,run_attempt,received_at);

CREATE OR REPLACE FUNCTION protect_release_workflow_fact_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'restricted CI/CD facts are immutable';
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION protect_release_workflow_fact_immutable() FROM PUBLIC;

DO $immutable_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'release_workflow_commands',
    'release_workflow_approvals',
    'release_workflow_activations',
    'release_workflow_first_production_enablements',
    'release_workflow_environment_generations',
    'release_workflow_attempts',
    'release_workflow_authorizations',
    'release_workflow_target_operations',
    'release_workflow_target_owner_epochs',
    'release_workflow_run_policy_attestations',
    'release_workflow_events',
    'release_workflow_deliveries',
    'release_workflow_receipts',
    'release_workflow_stop_receipts',
    'release_workflow_stops'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_release_workflow_fact_immutable()',
      'trg_' || table_name || '_immutable',
      table_name
    );
  END LOOP;
END
$immutable_triggers$;

DO $rls_and_acl$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'release_workflow_commands','release_workflow_approvals','release_workflow_activations',
    'release_workflow_first_production_enablements','release_workflow_environment_generations',
    'release_workflow_attempts','release_workflow_authorizations','release_workflow_target_operations',
    'release_workflow_target_owner_epochs',
    'release_workflow_run_policy_attestations','release_workflow_events','release_workflow_deliveries',
    'release_workflow_receipts','release_workflow_stop_receipts','release_workflow_stops','release_workflow_command_states',
    'release_workflow_environment_states'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
  END LOOP;
END
$rls_and_acl$;

REVOKE ALL ON SEQUENCE release_workflow_events_sequence_no_seq FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_request_command(
  p_id text,
  p_release_version_id text,
  p_environment text,
  p_action text,
  p_reason text,
  p_maker_user_id text,
  p_idempotency_key text,
  p_canonical_payload_sha256 text,
  p_snapshot_sha256 text,
  p_snapshot_json jsonb,
  p_artifact_manifest_sha256 text,
  p_workflow_sha256 text,
  p_environment_generation bigint,
  p_expected_current_release_version_id text
) RETURNS TABLE(command_id text,replayed boolean) AS $$
DECLARE
  existing release_workflow_commands%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  release_artifact_sha256 text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'release-workflow-command:' || p_maker_user_id || ':' || p_idempotency_key,
    0
  ));

  SELECT * INTO existing
    FROM release_workflow_commands
   WHERE maker_user_id=p_maker_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.id<>p_id
       OR existing.release_version_id<>p_release_version_id
       OR existing.environment<>p_environment
       OR existing.action<>p_action
       OR existing.reason<>p_reason
       OR existing.canonical_payload_sha256<>p_canonical_payload_sha256
       OR existing.snapshot_sha256<>p_snapshot_sha256
       OR existing.snapshot_json<>p_snapshot_json
       OR existing.artifact_manifest_sha256<>p_artifact_manifest_sha256
       OR existing.workflow_sha256<>p_workflow_sha256
       OR existing.environment_generation<>p_environment_generation
       OR existing.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id THEN
      RAISE EXCEPTION 'idempotency payload mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  IF jsonb_typeof(p_snapshot_json)<>'object'
     OR p_snapshot_json->>'schemaVersion'<>'1'
     OR p_snapshot_json->>'commandId' IS DISTINCT FROM p_id
     OR p_snapshot_json->>'releaseVersionId' IS DISTINCT FROM p_release_version_id
     OR p_snapshot_json->>'environment' IS DISTINCT FROM p_environment
     OR p_snapshot_json->>'action' IS DISTINCT FROM p_action
     OR p_snapshot_json->>'artifactManifestSha256' IS DISTINCT FROM p_artifact_manifest_sha256
     OR p_snapshot_json->>'workflowSha256' IS DISTINCT FROM p_workflow_sha256
     OR p_snapshot_json->>'environmentGeneration' IS DISTINCT FROM p_environment_generation::text
     OR p_snapshot_json->>'expectedCurrentReleaseVersionId' IS DISTINCT FROM p_expected_current_release_version_id THEN
    RAISE EXCEPTION 'snapshot binding mismatch' USING ERRCODE='22023';
  END IF;

  SELECT state.* INTO environment_state
    FROM release_workflow_environment_states AS state
   WHERE state.environment=p_environment
   FOR UPDATE;
  IF NOT FOUND
     OR environment_state.generation<>p_environment_generation
     OR environment_state.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id
     OR environment_state.stop_requested
     OR environment_state.blocked THEN
    RAISE EXCEPTION 'environment snapshot stale' USING ERRCODE='40001';
  END IF;

  SELECT artifact_sha256 INTO release_artifact_sha256
    FROM release_versions
   WHERE id=p_release_version_id;
  IF NOT FOUND OR release_artifact_sha256<>p_artifact_manifest_sha256 THEN
    RAISE EXCEPTION 'release artifact mismatch' USING ERRCODE='22023';
  END IF;

  INSERT INTO release_workflow_commands(
    id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
    canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
    workflow_sha256,environment_generation,expected_current_release_version_id
  ) VALUES(
    p_id,p_release_version_id,p_environment,p_action,p_reason,p_maker_user_id,p_idempotency_key,
    p_canonical_payload_sha256,p_snapshot_sha256,p_snapshot_json,p_artifact_manifest_sha256,
    p_workflow_sha256,p_environment_generation,p_expected_current_release_version_id
  );
  INSERT INTO release_workflow_command_states(command_id,status) VALUES(p_id,'requested');
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_review_command(
  p_id text,
  p_command_id text,
  p_checker_user_id text,
  p_decision text,
  p_reason text,
  p_snapshot_sha256 text,
  p_expires_at timestamptz
) RETURNS TABLE(approval_id text,replayed boolean) AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  state_record release_workflow_command_states%ROWTYPE;
  existing release_workflow_approvals%ROWTYPE;
BEGIN
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release command not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO state_record FROM release_workflow_command_states WHERE command_id=p_command_id FOR UPDATE;

  SELECT * INTO existing FROM release_workflow_approvals WHERE command_id=p_command_id;
  IF FOUND THEN
    IF existing.id<>p_id
       OR existing.checker_user_id<>p_checker_user_id
       OR existing.decision<>p_decision
       OR existing.reason<>p_reason
       OR existing.snapshot_sha256<>p_snapshot_sha256
       OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'approval replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  IF state_record.status<>'requested' THEN
    RAISE EXCEPTION 'command is not reviewable' USING ERRCODE='55000';
  END IF;
  IF command_record.maker_user_id=p_checker_user_id THEN
    RAISE EXCEPTION 'self approval forbidden' USING ERRCODE='42501';
  END IF;
  IF command_record.snapshot_sha256<>p_snapshot_sha256 THEN
    RAISE EXCEPTION 'snapshot mismatch' USING ERRCODE='22023';
  END IF;
  IF p_expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'approval expiry invalid' USING ERRCODE='22023';
  END IF;
  IF p_decision='approve' AND NOT EXISTS(
    SELECT 1 FROM release_verifications
     WHERE release_version_id=command_record.release_version_id AND decision='approve'
  ) THEN
    RAISE EXCEPTION 'release verification missing' USING ERRCODE='55000';
  END IF;

  INSERT INTO release_workflow_approvals(
    id,command_id,decision,checker_user_id,reason,snapshot_sha256,expires_at
  ) VALUES(p_id,p_command_id,p_decision,p_checker_user_id,p_reason,p_snapshot_sha256,p_expires_at);
  UPDATE release_workflow_command_states
     SET status=CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         updated_at=CURRENT_TIMESTAMP
   WHERE command_id=p_command_id;
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_record_activation(
  p_id text,
  p_environment text,
  p_g7_manifest_sha256 text,
  p_provider_binding_sha256 text,
  p_artifact_manifest_sha256 text,
  p_workflow_sha256 text,
  p_environment_policy_sha256 text,
  p_runner_policy_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_auditor_trust_sha256 text,
  p_reviewer_allowlist_sha256 text,
  p_security_approver_user_id text,
  p_release_approver_user_id text,
  p_reason text,
  p_expires_at timestamptz
) RETURNS TABLE(activation_id text,replayed boolean) AS $$
DECLARE
  existing release_workflow_activations%ROWTYPE;
BEGIN
  IF p_security_approver_user_id=p_release_approver_user_id THEN
    RAISE EXCEPTION 'dual control required' USING ERRCODE='42501';
  END IF;
  IF p_expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'activation expiry invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-activation:' || p_id,0));
  SELECT * INTO existing FROM release_workflow_activations WHERE id=p_id;
  IF FOUND THEN
    IF existing.environment<>p_environment
       OR existing.g7_manifest_sha256<>p_g7_manifest_sha256
       OR existing.provider_binding_sha256<>p_provider_binding_sha256
       OR existing.artifact_manifest_sha256<>p_artifact_manifest_sha256
       OR existing.workflow_sha256<>p_workflow_sha256
       OR existing.environment_policy_sha256<>p_environment_policy_sha256
       OR existing.runner_policy_sha256<>p_runner_policy_sha256
       OR existing.target_binding_sha256<>p_target_binding_sha256
       OR existing.receipt_trust_sha256<>p_receipt_trust_sha256
       OR existing.auditor_trust_sha256<>p_auditor_trust_sha256
       OR existing.reviewer_allowlist_sha256<>p_reviewer_allowlist_sha256
       OR existing.security_approver_user_id<>p_security_approver_user_id
       OR existing.release_approver_user_id<>p_release_approver_user_id
       OR existing.reason<>p_reason
       OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'activation replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  INSERT INTO release_workflow_activations(
    id,environment,g7_manifest_sha256,provider_binding_sha256,artifact_manifest_sha256,
    workflow_sha256,environment_policy_sha256,runner_policy_sha256,target_binding_sha256,
    receipt_trust_sha256,auditor_trust_sha256,reviewer_allowlist_sha256,
    security_approver_user_id,release_approver_user_id,reason,expires_at
  ) VALUES(
    p_id,p_environment,p_g7_manifest_sha256,p_provider_binding_sha256,p_artifact_manifest_sha256,
    p_workflow_sha256,p_environment_policy_sha256,p_runner_policy_sha256,p_target_binding_sha256,
    p_receipt_trust_sha256,p_auditor_trust_sha256,p_reviewer_allowlist_sha256,
    p_security_approver_user_id,p_release_approver_user_id,p_reason,p_expires_at
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_record_first_production_enablement(
  p_id text,
  p_activation_id text,
  p_actor_user_id text,
  p_recent_mfa_evidence_sha256 text,
  p_g7_manifest_sha256 text,
  p_provider_binding_sha256 text,
  p_workflow_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_reason text,
  p_expires_at timestamptz
) RETURNS TABLE(enablement_id text,replayed boolean) AS $$
DECLARE
  activation release_workflow_activations%ROWTYPE;
  existing release_workflow_first_production_enablements%ROWTYPE;
BEGIN
  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  IF NOT FOUND OR activation.environment<>'production' OR activation.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'production activation unavailable' USING ERRCODE='55000';
  END IF;
  IF activation.g7_manifest_sha256<>p_g7_manifest_sha256
     OR activation.provider_binding_sha256<>p_provider_binding_sha256
     OR activation.workflow_sha256<>p_workflow_sha256
     OR activation.target_binding_sha256<>p_target_binding_sha256
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256 THEN
    RAISE EXCEPTION 'activation binding mismatch' USING ERRCODE='22023';
  END IF;
  IF p_expires_at<=CURRENT_TIMESTAMP OR p_expires_at>activation.expires_at THEN
    RAISE EXCEPTION 'enablement expiry invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-enablement:' || p_id,0));
  SELECT * INTO existing FROM release_workflow_first_production_enablements WHERE id=p_id;
  IF FOUND THEN
    IF existing.activation_id<>p_activation_id
       OR existing.actor_user_id<>p_actor_user_id
       OR existing.recent_mfa_evidence_sha256<>p_recent_mfa_evidence_sha256
       OR existing.g7_manifest_sha256<>p_g7_manifest_sha256
       OR existing.provider_binding_sha256<>p_provider_binding_sha256
       OR existing.workflow_sha256<>p_workflow_sha256
       OR existing.target_binding_sha256<>p_target_binding_sha256
       OR existing.receipt_trust_sha256<>p_receipt_trust_sha256
       OR existing.reason<>p_reason
       OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'enablement replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  INSERT INTO release_workflow_first_production_enablements(
    id,activation_id,actor_user_id,recent_mfa_evidence_sha256,g7_manifest_sha256,
    provider_binding_sha256,workflow_sha256,target_binding_sha256,receipt_trust_sha256,
    reason,expires_at
  ) VALUES(
    p_id,p_activation_id,p_actor_user_id,p_recent_mfa_evidence_sha256,p_g7_manifest_sha256,
    p_provider_binding_sha256,p_workflow_sha256,p_target_binding_sha256,p_receipt_trust_sha256,
    p_reason,p_expires_at
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_lease_command(
  p_attempt_key text,
  p_command_id text,
  p_lease_owner text,
  p_lease_seconds integer,
  p_activation_id text,
  p_g7_manifest_sha256 text,
  p_provider_binding_sha256 text,
  p_environment_policy_sha256 text,
  p_runner_policy_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_auditor_trust_sha256 text,
  p_reviewer_allowlist_sha256 text
) RETURNS TABLE(
  attempt_key text,
  fencing_token bigint,
  command_id text,
  release_version_id text,
  environment text,
  action text,
  snapshot_sha256 text,
  artifact_manifest_sha256 text,
  workflow_sha256 text,
  environment_generation bigint,
  expected_current_release_version_id text,
  lease_expires_at timestamptz,
  replayed boolean
) AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
  approval release_workflow_approvals%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  active_lease release_workflow_attempts%ROWTYPE;
  existing release_workflow_attempts%ROWTYPE;
  next_fencing_token bigint;
  lease_expiry timestamptz;
BEGIN
  IF p_lease_seconds<30 OR p_lease_seconds>900 THEN
    RAISE EXCEPTION 'lease duration invalid' USING ERRCODE='22023';
  END IF;

  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release command not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=p_command_id
   FOR UPDATE;
  SELECT * INTO approval
    FROM release_workflow_approvals
   WHERE release_workflow_approvals.command_id=p_command_id;
  IF NOT FOUND OR approval.decision<>'approve' OR approval.snapshot_sha256<>command_record.snapshot_sha256
     OR approval.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'approved command unavailable' USING ERRCODE='55000';
  END IF;

  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  IF NOT FOUND OR activation.environment<>command_record.environment OR activation.expires_at<=CURRENT_TIMESTAMP
     OR activation.g7_manifest_sha256<>p_g7_manifest_sha256
     OR activation.provider_binding_sha256<>p_provider_binding_sha256
     OR activation.artifact_manifest_sha256<>command_record.artifact_manifest_sha256
     OR activation.workflow_sha256<>command_record.workflow_sha256
     OR activation.environment_policy_sha256<>p_environment_policy_sha256
     OR activation.runner_policy_sha256<>p_runner_policy_sha256
     OR activation.target_binding_sha256<>p_target_binding_sha256
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256
     OR activation.auditor_trust_sha256<>p_auditor_trust_sha256
     OR activation.reviewer_allowlist_sha256<>p_reviewer_allowlist_sha256 THEN
    RAISE EXCEPTION 'activation binding unavailable' USING ERRCODE='55000';
  END IF;
  IF command_record.environment='production' AND NOT EXISTS(
    SELECT 1 FROM release_workflow_first_production_enablements AS enablement
     WHERE enablement.activation_id=activation.id
       AND enablement.g7_manifest_sha256=activation.g7_manifest_sha256
       AND enablement.provider_binding_sha256=activation.provider_binding_sha256
       AND enablement.workflow_sha256=activation.workflow_sha256
       AND enablement.target_binding_sha256=activation.target_binding_sha256
       AND enablement.receipt_trust_sha256=activation.receipt_trust_sha256
       AND enablement.expires_at>CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'first production enablement unavailable' USING ERRCODE='55000';
  END IF;

  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=command_record.environment
   FOR UPDATE;
  IF environment_state.generation<>command_record.environment_generation
     OR environment_state.expected_current_release_version_id IS DISTINCT FROM command_record.expected_current_release_version_id
     OR environment_state.stop_requested OR environment_state.blocked
     OR environment_state.active_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'environment snapshot stale' USING ERRCODE='40001';
  END IF;

  SELECT * INTO existing
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF FOUND THEN
    IF existing.command_id<>p_command_id OR existing.activation_id<>p_activation_id
       OR existing.lease_owner<>p_lease_owner OR existing.environment<>command_record.environment
       OR existing.environment_generation<>command_record.environment_generation
       OR existing.snapshot_sha256<>command_record.snapshot_sha256
       OR existing.lease_expires_at<=CURRENT_TIMESTAMP
       OR environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key THEN
      RAISE EXCEPTION 'lease replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT
      existing.attempt_key,existing.fencing_token,command_record.id,command_record.release_version_id,
      command_record.environment,command_record.action,command_record.snapshot_sha256,
      command_record.artifact_manifest_sha256,command_record.workflow_sha256,
      command_record.environment_generation,command_record.expected_current_release_version_id,
      existing.lease_expires_at,true;
    RETURN;
  END IF;

  IF command_state.status<>'approved' THEN
    RAISE EXCEPTION 'command is not leaseable' USING ERRCODE='55000';
  END IF;
  IF environment_state.active_attempt_key IS NOT NULL THEN
    SELECT * INTO active_lease
      FROM release_workflow_attempts
     WHERE release_workflow_attempts.attempt_key=environment_state.active_attempt_key
       AND fact_kind='leased';
    IF FOUND AND active_lease.lease_expires_at>CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'active lease exists' USING ERRCODE='55000';
    END IF;
  END IF;

  SELECT COALESCE(max(release_workflow_attempts.fencing_token),0)+1 INTO next_fencing_token
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.environment=command_record.environment;
  lease_expiry := CURRENT_TIMESTAMP + make_interval(secs=>p_lease_seconds);
  INSERT INTO release_workflow_attempts(
    id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
    environment_generation,snapshot_sha256,lease_expires_at
  ) VALUES(
    p_attempt_key || '-leased',p_attempt_key,p_command_id,p_activation_id,command_record.environment,
    'leased',p_lease_owner,next_fencing_token,command_record.environment_generation,
    command_record.snapshot_sha256,lease_expiry
  );
  UPDATE release_workflow_environment_states
     SET active_attempt_key=p_attempt_key,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=command_record.environment;
  UPDATE release_workflow_command_states
     SET status='leased',current_attempt_key=p_attempt_key,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_command_states.command_id=p_command_id;

  RETURN QUERY SELECT
    p_attempt_key,next_fencing_token,command_record.id,command_record.release_version_id,
    command_record.environment,command_record.action,command_record.snapshot_sha256,
    command_record.artifact_manifest_sha256,command_record.workflow_sha256,
    command_record.environment_generation,command_record.expected_current_release_version_id,
    lease_expiry,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_bind_provider_run(
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_provider_run_id text,
  p_provider_run_url text,
  p_dispatch_request_sha256 text
) RETURNS TABLE(provider_run_id text,replayed boolean) AS $$
DECLARE
  lease_record release_workflow_attempts%ROWTYPE;
  existing release_workflow_attempts%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
BEGIN
  SELECT * INTO lease_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF NOT FOUND THEN RAISE EXCEPTION 'lease not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=lease_record.environment
   FOR UPDATE;
  IF lease_record.lease_owner<>p_lease_owner OR lease_record.fencing_token<>p_fencing_token
     OR lease_record.lease_expires_at<=CURRENT_TIMESTAMP
     OR environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key
     OR environment_state.generation<>lease_record.environment_generation
     OR environment_state.stop_requested OR environment_state.blocked THEN
    RAISE EXCEPTION 'stale lease fence' USING ERRCODE='40001';
  END IF;
  IF p_provider_run_url<>format('https://github.com/agentnovas/platform/actions/runs/%s',p_provider_run_id) THEN
    RAISE EXCEPTION 'provider run url mismatch' USING ERRCODE='22023';
  END IF;

  SELECT * INTO existing
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF FOUND THEN
    IF existing.provider_run_id<>p_provider_run_id OR existing.provider_run_attempt<>1
       OR existing.provider_run_url<>p_provider_run_url
       OR existing.dispatch_request_sha256<>p_dispatch_request_sha256
       OR existing.lease_owner<>p_lease_owner OR existing.fencing_token<>p_fencing_token THEN
      RAISE EXCEPTION 'provider run replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.provider_run_id,true;
    RETURN;
  END IF;

  INSERT INTO release_workflow_attempts(
    id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
    environment_generation,snapshot_sha256,lease_expires_at,provider_run_id,provider_run_attempt,
    provider_run_url,dispatch_request_sha256
  ) VALUES(
    p_attempt_key || '-run-bound',p_attempt_key,lease_record.command_id,lease_record.activation_id,
    lease_record.environment,'run_bound',lease_record.lease_owner,lease_record.fencing_token,
    lease_record.environment_generation,lease_record.snapshot_sha256,lease_record.lease_expires_at,
    p_provider_run_id,1,p_provider_run_url,p_dispatch_request_sha256
  );
  UPDATE release_workflow_command_states
     SET status='dispatch_accepted',updated_at=CURRENT_TIMESTAMP
   WHERE command_id=lease_record.command_id AND current_attempt_key=p_attempt_key;
  RETURN QUERY SELECT p_provider_run_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_append_delivery(
  p_id text,
  p_event_name text,
  p_action text,
  p_repository_id text,
  p_workflow_id text,
  p_run_id text,
  p_run_attempt integer,
  p_head_sha text,
  p_head_ref text,
  p_status text,
  p_conclusion text,
  p_body_sha256 text,
  p_payload_size_bytes integer
) RETURNS TABLE(delivery_id text,replayed boolean) AS $$
DECLARE
  existing release_workflow_deliveries%ROWTYPE;
BEGIN
  IF p_event_name<>'workflow_run' OR p_action NOT IN ('requested','in_progress','completed') THEN
    RAISE EXCEPTION 'delivery event not allowlisted' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-delivery:' || p_id,0));
  SELECT * INTO existing FROM release_workflow_deliveries WHERE id=p_id;
  IF FOUND THEN
    IF existing.event_name<>p_event_name OR existing.action<>p_action
       OR existing.repository_id<>p_repository_id OR existing.workflow_id<>p_workflow_id
       OR existing.run_id<>p_run_id OR existing.run_attempt<>p_run_attempt
       OR existing.head_sha<>p_head_sha OR existing.head_ref<>p_head_ref
       OR existing.status<>p_status OR existing.conclusion IS DISTINCT FROM p_conclusion
       OR existing.body_sha256<>p_body_sha256 OR existing.payload_size_bytes<>p_payload_size_bytes THEN
      RAISE EXCEPTION 'delivery replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;
  INSERT INTO release_workflow_deliveries(
    id,event_name,action,repository_id,workflow_id,run_id,run_attempt,head_sha,head_ref,
    status,conclusion,body_sha256,payload_size_bytes
  ) VALUES(
    p_id,p_event_name,p_action,p_repository_id,p_workflow_id,p_run_id,p_run_attempt,p_head_sha,
    p_head_ref,p_status,p_conclusion,p_body_sha256,p_payload_size_bytes
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_append_run_policy_attestation(
  p_id text,
  p_repository_id text,
  p_workflow_id text,
  p_run_id text,
  p_run_attempt integer,
  p_job_id text,
  p_environment text,
  p_environment_policy_sha256 text,
  p_runner_policy_sha256 text,
  p_review_evidence_sha256 text,
  p_oidc_jti_sha256 text,
  p_nonce text,
  p_key_id text,
  p_signature text,
  p_expires_at timestamptz
) RETURNS TABLE(attestation_id text,replayed boolean) AS $$
DECLARE
  existing release_workflow_run_policy_attestations%ROWTYPE;
BEGIN
  IF p_run_attempt<>1 OR p_expires_at<=CURRENT_TIMESTAMP
     OR p_expires_at>CURRENT_TIMESTAMP + interval '15 minutes' THEN
    RAISE EXCEPTION 'attestation window invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-attestation:' || p_id,0));
  SELECT * INTO existing FROM release_workflow_run_policy_attestations WHERE id=p_id;
  IF FOUND THEN
    IF existing.repository_id<>p_repository_id OR existing.workflow_id<>p_workflow_id
       OR existing.run_id<>p_run_id OR existing.run_attempt<>p_run_attempt
       OR existing.job_id<>p_job_id OR existing.environment<>p_environment
       OR existing.environment_policy_sha256<>p_environment_policy_sha256
       OR existing.runner_policy_sha256<>p_runner_policy_sha256
       OR existing.review_evidence_sha256<>p_review_evidence_sha256
       OR existing.oidc_jti_sha256<>p_oidc_jti_sha256 OR existing.nonce<>p_nonce
       OR existing.key_id<>p_key_id OR existing.signature<>p_signature
       OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'attestation replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;
  INSERT INTO release_workflow_run_policy_attestations(
    id,repository_id,workflow_id,run_id,run_attempt,job_id,environment,
    environment_policy_sha256,runner_policy_sha256,review_evidence_sha256,
    oidc_jti_sha256,nonce,key_id,signature,expires_at
  ) VALUES(
    p_id,p_repository_id,p_workflow_id,p_run_id,p_run_attempt,p_job_id,p_environment,
    p_environment_policy_sha256,p_runner_policy_sha256,p_review_evidence_sha256,
    p_oidc_jti_sha256,p_nonce,p_key_id,p_signature,p_expires_at
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_reserve_exact_run_operation(
  p_authorization_id text,
  p_operation_id text,
  p_command_id text,
  p_attempt_key text,
  p_attestation_id text,
  p_oidc_jti_sha256 text,
  p_authorization_nonce text,
  p_target_owner_identity_sha256 text,
  p_target_owner_evidence_sha256 text,
  p_expires_at timestamptz
) RETURNS TABLE(operation_id text,owner_epoch bigint,replayed boolean) AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
  approval release_workflow_approvals%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  attestation release_workflow_run_policy_attestations%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  existing_operation release_workflow_target_operations%ROWTYPE;
  existing_authorization release_workflow_authorizations%ROWTYPE;
  initial_owner release_workflow_target_owner_epochs%ROWTYPE;
BEGIN
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF NOT FOUND OR run_binding.command_id<>p_command_id THEN
    RAISE EXCEPTION 'run binding mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=p_command_id
   FOR UPDATE;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=command_record.environment
   FOR UPDATE;
  SELECT * INTO existing_operation
    FROM release_workflow_target_operations
   WHERE release_workflow_target_operations.command_id=p_command_id;
  IF FOUND THEN
    SELECT * INTO existing_authorization
      FROM release_workflow_authorizations
     WHERE id=existing_operation.authorization_id;
    SELECT * INTO initial_owner
      FROM release_workflow_target_owner_epochs
     WHERE release_workflow_target_owner_epochs.operation_id=existing_operation.id
       AND release_workflow_target_owner_epochs.owner_epoch=1;
    IF existing_operation.id<>p_operation_id OR existing_authorization.id<>p_authorization_id
       OR existing_authorization.attempt_key<>p_attempt_key
       OR existing_authorization.attestation_id<>p_attestation_id
       OR existing_authorization.oidc_jti_sha256<>p_oidc_jti_sha256
       OR existing_authorization.authorization_nonce<>p_authorization_nonce
       OR existing_authorization.expires_at<>p_expires_at
       OR initial_owner.owner_identity_sha256<>p_target_owner_identity_sha256
       OR initial_owner.evidence_sha256<>p_target_owner_evidence_sha256 THEN
      RAISE EXCEPTION 'operation replay mismatch' USING ERRCODE='23505';
    END IF;
    IF initial_owner.id IS NULL
       OR environment_state.active_operation_id IS DISTINCT FROM existing_operation.id
       OR environment_state.target_owner_epoch IS DISTINCT FROM initial_owner.owner_epoch
       OR EXISTS(
         SELECT 1 FROM release_workflow_receipts AS receipt_fact
          WHERE receipt_fact.operation_id=existing_operation.id
       ) THEN
      RAISE EXCEPTION 'stale target owner epoch' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT existing_operation.id,environment_state.target_owner_epoch,true;
    RETURN;
  END IF;
  IF command_state.status<>'dispatch_accepted' OR command_state.current_attempt_key IS DISTINCT FROM p_attempt_key THEN
    RAISE EXCEPTION 'command is not authorizable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO approval
    FROM release_workflow_approvals
   WHERE release_workflow_approvals.command_id=p_command_id;
  IF NOT FOUND OR approval.decision<>'approve' OR approval.snapshot_sha256<>command_record.snapshot_sha256
     OR approval.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'approval unavailable' USING ERRCODE='55000';
  END IF;
  IF run_binding.provider_run_attempt<>1 OR run_binding.lease_expires_at<=CURRENT_TIMESTAMP
     OR run_binding.snapshot_sha256<>command_record.snapshot_sha256
     OR run_binding.environment_generation<>command_record.environment_generation THEN
    RAISE EXCEPTION 'run binding expired or stale' USING ERRCODE='40001';
  END IF;

  IF environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key
     OR environment_state.active_operation_id IS NOT NULL
     OR environment_state.generation<>command_record.environment_generation
     OR environment_state.expected_current_release_version_id IS DISTINCT FROM command_record.expected_current_release_version_id
     OR environment_state.stop_requested OR environment_state.blocked THEN
    RAISE EXCEPTION 'environment authorization stale' USING ERRCODE='40001';
  END IF;

  SELECT * INTO activation FROM release_workflow_activations WHERE id=run_binding.activation_id;
  IF NOT FOUND OR activation.expires_at<=CURRENT_TIMESTAMP OR activation.environment<>command_record.environment
     OR activation.artifact_manifest_sha256<>command_record.artifact_manifest_sha256
     OR activation.workflow_sha256<>command_record.workflow_sha256 THEN
    RAISE EXCEPTION 'activation unavailable' USING ERRCODE='55000';
  END IF;
  IF command_record.environment='production' AND NOT EXISTS(
    SELECT 1 FROM release_workflow_first_production_enablements AS enablement
     WHERE enablement.activation_id=activation.id
       AND enablement.g7_manifest_sha256=activation.g7_manifest_sha256
       AND enablement.provider_binding_sha256=activation.provider_binding_sha256
       AND enablement.workflow_sha256=activation.workflow_sha256
       AND enablement.target_binding_sha256=activation.target_binding_sha256
       AND enablement.receipt_trust_sha256=activation.receipt_trust_sha256
       AND enablement.expires_at>CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'first production enablement unavailable' USING ERRCODE='55000';
  END IF;

  SELECT * INTO attestation
    FROM release_workflow_run_policy_attestations
   WHERE id=p_attestation_id;
  IF NOT FOUND OR attestation.run_id<>run_binding.provider_run_id
     OR attestation.run_attempt<>run_binding.provider_run_attempt
     OR attestation.environment<>command_record.environment
     OR attestation.environment_policy_sha256<>activation.environment_policy_sha256
     OR attestation.runner_policy_sha256<>activation.runner_policy_sha256
     OR attestation.oidc_jti_sha256<>p_oidc_jti_sha256
     OR attestation.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'run policy attestation mismatch' USING ERRCODE='22023';
  END IF;
  IF p_expires_at<=CURRENT_TIMESTAMP OR p_expires_at>attestation.expires_at
     OR p_expires_at>approval.expires_at OR p_expires_at>activation.expires_at
     OR p_expires_at>run_binding.lease_expires_at THEN
    RAISE EXCEPTION 'authorization expiry invalid' USING ERRCODE='22023';
  END IF;

  INSERT INTO release_workflow_authorizations(
    id,command_id,attempt_key,attestation_id,run_id,run_attempt,oidc_jti_sha256,
    authorization_nonce,operation_id,expires_at
  ) VALUES(
    p_authorization_id,p_command_id,p_attempt_key,p_attestation_id,run_binding.provider_run_id,
    run_binding.provider_run_attempt,p_oidc_jti_sha256,p_authorization_nonce,p_operation_id,p_expires_at
  );
  INSERT INTO release_workflow_target_operations(
    id,authorization_id,command_id,environment,action,snapshot_sha256,artifact_manifest_sha256,
    workflow_sha256,environment_generation,expected_current_release_version_id,
    worker_fencing_token,owner_epoch
  ) VALUES(
    p_operation_id,p_authorization_id,p_command_id,command_record.environment,command_record.action,
    command_record.snapshot_sha256,command_record.artifact_manifest_sha256,command_record.workflow_sha256,
    command_record.environment_generation,command_record.expected_current_release_version_id,
    run_binding.fencing_token,1
  );
  INSERT INTO release_workflow_target_owner_epochs(
    id,operation_id,environment,previous_owner_epoch,owner_epoch,owner_identity_sha256,
    evidence_sha256,reason
  ) VALUES(
    p_operation_id || '-owner-1',p_operation_id,command_record.environment,NULL,1,
    p_target_owner_identity_sha256,p_target_owner_evidence_sha256,
    'Initial target operation owner reservation'
  );
  UPDATE release_workflow_environment_states
     SET active_operation_id=p_operation_id,target_owner_epoch=1,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=command_record.environment;
  UPDATE release_workflow_command_states
     SET status='running',updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_command_states.command_id=p_command_id;
  RETURN QUERY SELECT p_operation_id,1::bigint,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_takeover_target_operation(
  p_id text,
  p_operation_id text,
  p_expected_owner_epoch bigint,
  p_new_owner_epoch bigint,
  p_owner_identity_sha256 text,
  p_evidence_sha256 text,
  p_reason text
) RETURNS TABLE(owner_epoch bigint,replayed boolean) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  existing release_workflow_target_owner_epochs%ROWTYPE;
BEGIN
  SELECT * INTO operation FROM release_workflow_target_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target operation not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=operation.environment
   FOR UPDATE;
  IF EXISTS(
    SELECT 1 FROM release_workflow_receipts AS receipt_fact
     WHERE receipt_fact.operation_id=p_operation_id
       AND receipt_fact.phase IN (
         'failed_before_cutover','uncertain_before_cutover','health_verified',
         'health_failed_after_cutover','uncertain_after_cutover','stop_committed'
       )
  ) THEN
    RAISE EXCEPTION 'target operation terminal' USING ERRCODE='55000';
  END IF;
  SELECT * INTO existing FROM release_workflow_target_owner_epochs WHERE id=p_id;
  IF FOUND THEN
    IF existing.operation_id<>p_operation_id OR existing.previous_owner_epoch<>p_expected_owner_epoch
       OR existing.owner_epoch<>p_new_owner_epoch
       OR existing.owner_identity_sha256<>p_owner_identity_sha256
       OR existing.evidence_sha256<>p_evidence_sha256 OR existing.reason<>p_reason THEN
      RAISE EXCEPTION 'target owner replay mismatch' USING ERRCODE='23505';
    END IF;
    IF environment_state.active_operation_id IS DISTINCT FROM p_operation_id
       OR environment_state.target_owner_epoch IS DISTINCT FROM existing.owner_epoch THEN
      RAISE EXCEPTION 'stale target owner epoch' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT existing.owner_epoch,true;
    RETURN;
  END IF;
  IF environment_state.active_operation_id IS DISTINCT FROM p_operation_id
     OR environment_state.target_owner_epoch IS DISTINCT FROM p_expected_owner_epoch
     OR p_new_owner_epoch<>p_expected_owner_epoch+1 THEN
    RAISE EXCEPTION 'stale target owner epoch' USING ERRCODE='40001';
  END IF;
  INSERT INTO release_workflow_target_owner_epochs(
    id,operation_id,environment,previous_owner_epoch,owner_epoch,owner_identity_sha256,
    evidence_sha256,reason
  ) VALUES(
    p_id,p_operation_id,operation.environment,p_expected_owner_epoch,p_new_owner_epoch,
    p_owner_identity_sha256,p_evidence_sha256,p_reason
  );
  UPDATE release_workflow_environment_states
     SET target_owner_epoch=p_new_owner_epoch,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=operation.environment
     AND active_operation_id=p_operation_id
     AND target_owner_epoch=p_expected_owner_epoch;
  RETURN QUERY SELECT p_new_owner_epoch,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_recompute_command_projection(
  p_command_id text
) RETURNS void AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  state_record release_workflow_command_states%ROWTYPE;
  operation release_workflow_target_operations%ROWTYPE;
  receipt release_workflow_receipts%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  provider_success boolean;
  provider_failure boolean;
  provider_cancelled boolean;
  provider_terminal_conflict boolean;
  provider_terminal_kinds integer;
  next_status text;
  next_receipt_missing boolean;
  physical_cutover boolean;
  target_uncertain boolean;
  has_failed_before boolean;
  has_stop_committed boolean;
  has_health_verified boolean;
  has_health_failed boolean;
  has_uncertain_before boolean;
  has_uncertain_after boolean;
  physical_receipt release_workflow_receipts%ROWTYPE;
BEGIN
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  SELECT * INTO state_record
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=p_command_id
   FOR UPDATE;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=command_record.environment
   FOR UPDATE;
  SELECT * INTO operation
    FROM release_workflow_target_operations
   WHERE release_workflow_target_operations.command_id=p_command_id;
  IF FOUND THEN
    SELECT * INTO receipt
      FROM release_workflow_receipts
     WHERE operation_id=operation.id
     ORDER BY journal_sequence DESC LIMIT 1;
    SELECT * INTO physical_receipt
      FROM release_workflow_receipts
     WHERE operation_id=operation.id
       AND phase IN (
         'cutover_committed','health_verified','health_failed_after_cutover','uncertain_after_cutover'
       )
     ORDER BY journal_sequence DESC LIMIT 1;
    SELECT
      COALESCE(bool_or(phase='failed_before_cutover'),false),
      COALESCE(bool_or(phase='stop_committed'),false),
      COALESCE(bool_or(phase='health_verified'),false),
      COALESCE(bool_or(phase='health_failed_after_cutover'),false),
      COALESCE(bool_or(phase='uncertain_before_cutover'),false),
      COALESCE(bool_or(phase='uncertain_after_cutover'),false)
    INTO
      has_failed_before,has_stop_committed,has_health_verified,has_health_failed,
      has_uncertain_before,has_uncertain_after
    FROM release_workflow_receipts
    WHERE operation_id=operation.id;
  ELSE
    has_failed_before := false;
    has_stop_committed := false;
    has_health_verified := false;
    has_health_failed := false;
    has_uncertain_before := false;
    has_uncertain_after := false;
  END IF;
  SELECT
    EXISTS(SELECT 1 FROM release_workflow_events WHERE command_id=p_command_id AND kind='completed_success'),
    EXISTS(SELECT 1 FROM release_workflow_events WHERE command_id=p_command_id AND kind='completed_failure'),
    EXISTS(SELECT 1 FROM release_workflow_events WHERE command_id=p_command_id AND kind='completed_cancelled'),
    count(DISTINCT kind) FILTER (
      WHERE kind IN ('completed_success','completed_failure','completed_cancelled')
    )
  INTO provider_success,provider_failure,provider_cancelled,provider_terminal_kinds
  FROM release_workflow_events
  WHERE command_id=p_command_id;
  provider_terminal_conflict := provider_terminal_kinds>1;

  physical_cutover := physical_receipt.id IS NOT NULL
    AND physical_receipt.actual_current_release_version_id IS NOT NULL;
  target_uncertain := has_uncertain_before OR has_uncertain_after;
  next_receipt_missing := operation.id IS NOT NULL AND receipt.id IS NULL;

  IF physical_cutover AND (provider_failure OR provider_cancelled) THEN
    next_status := 'deployed_reconciliation_required';
  ELSIF has_health_failed OR has_uncertain_after THEN
    next_status := 'deployed_reconciliation_required';
  ELSIF provider_terminal_conflict THEN
    next_status := 'manual_intervention';
  ELSIF has_uncertain_before THEN
    next_status := 'manual_intervention';
  ELSIF has_health_verified AND provider_success THEN
    next_status := 'succeeded';
  ELSIF has_failed_before THEN
    next_status := 'failed';
  ELSIF has_stop_committed THEN
    next_status := 'cancelled';
  ELSIF operation.id IS NOT NULL THEN
    next_status := 'settling';
  ELSIF provider_cancelled THEN
    next_status := 'cancelled';
  ELSIF provider_failure THEN
    next_status := 'failed';
  ELSIF provider_success THEN
    next_status := 'settling';
    next_receipt_missing := true;
  ELSE
    RETURN;
  END IF;

  UPDATE release_workflow_command_states
     SET status=next_status,receipt_missing=next_receipt_missing,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_command_states.command_id=p_command_id;

  IF provider_terminal_conflict THEN
    UPDATE release_workflow_environment_states
       SET blocked=true,updated_at=CURRENT_TIMESTAMP
     WHERE release_workflow_environment_states.environment=command_record.environment;
  END IF;

  IF operation.id IS NOT NULL
     AND environment_state.active_operation_id IS NOT DISTINCT FROM operation.id THEN
    IF physical_cutover THEN
      UPDATE release_workflow_environment_states
         SET expected_current_release_version_id=physical_receipt.actual_current_release_version_id,
             blocked=(release_workflow_environment_states.blocked
               OR next_status='deployed_reconciliation_required' OR target_uncertain),
             active_attempt_key=CASE WHEN next_status='succeeded' THEN NULL ELSE active_attempt_key END,
             active_operation_id=CASE WHEN next_status='succeeded' THEN NULL ELSE active_operation_id END,
             target_owner_epoch=CASE WHEN next_status='succeeded' THEN NULL ELSE target_owner_epoch END,
             updated_at=CURRENT_TIMESTAMP
       WHERE release_workflow_environment_states.environment=command_record.environment
         AND active_operation_id=operation.id;
    ELSIF target_uncertain THEN
      UPDATE release_workflow_environment_states
         SET expected_current_release_version_id=CASE
               WHEN has_uncertain_after THEN NULL
               ELSE release_workflow_environment_states.expected_current_release_version_id
             END,
             blocked=true,updated_at=CURRENT_TIMESTAMP
       WHERE release_workflow_environment_states.environment=command_record.environment
         AND active_operation_id=operation.id;
    ELSIF has_failed_before OR has_stop_committed THEN
      UPDATE release_workflow_environment_states
         SET active_attempt_key=NULL,active_operation_id=NULL,target_owner_epoch=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE release_workflow_environment_states.environment=command_record.environment
         AND active_operation_id=operation.id;
    END IF;
  ELSIF operation.id IS NULL AND next_status IN ('failed','cancelled') THEN
    UPDATE release_workflow_environment_states
       SET active_attempt_key=NULL,updated_at=CURRENT_TIMESTAMP
     WHERE release_workflow_environment_states.environment=command_record.environment
       AND active_attempt_key=state_record.current_attempt_key;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_recompute_command_projection(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_append_target_receipt(
  p_id text,
  p_operation_id text,
  p_receipt_nonce text,
  p_key_id text,
  p_payload_json jsonb,
  p_payload_sha256 text,
  p_signature text,
  p_phase text,
  p_owner_epoch bigint,
  p_journal_sequence bigint,
  p_actual_previous_release_version_id text,
  p_actual_current_release_version_id text,
  p_signature_verified boolean
) RETURNS TABLE(receipt_id text,replayed boolean) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  command_record release_workflow_commands%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  existing release_workflow_receipts%ROWTYPE;
  previous_receipt release_workflow_receipts%ROWTYPE;
  expected_sequence bigint;
BEGIN
  SELECT * INTO operation FROM release_workflow_target_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target operation not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=operation.command_id FOR SHARE;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=operation.command_id
   FOR UPDATE;

  SELECT * INTO existing FROM release_workflow_receipts WHERE id=p_id;
  IF FOUND THEN
    IF existing.operation_id<>p_operation_id OR existing.command_id<>operation.command_id
       OR existing.receipt_nonce<>p_receipt_nonce OR existing.key_id<>p_key_id
       OR existing.payload_json<>p_payload_json OR existing.payload_sha256<>p_payload_sha256
       OR existing.signature<>p_signature OR existing.phase<>p_phase
       OR existing.owner_epoch<>p_owner_epoch OR existing.journal_sequence<>p_journal_sequence
       OR existing.actual_previous_release_version_id IS DISTINCT FROM p_actual_previous_release_version_id
       OR existing.actual_current_release_version_id IS DISTINCT FROM p_actual_current_release_version_id
       OR existing.signature_verified IS DISTINCT FROM p_signature_verified THEN
      RAISE EXCEPTION 'receipt replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  IF p_signature_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'receipt signature not verified' USING ERRCODE='42501';
  END IF;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=operation.environment
   FOR UPDATE;
  IF environment_state.active_operation_id IS DISTINCT FROM operation.id
     OR environment_state.target_owner_epoch IS DISTINCT FROM p_owner_epoch THEN
    RAISE EXCEPTION 'stale owner epoch' USING ERRCODE='40001';
  END IF;
  SELECT COALESCE(max(journal_sequence),0)+1 INTO expected_sequence
    FROM release_workflow_receipts
   WHERE operation_id=p_operation_id;
  IF p_journal_sequence<>expected_sequence THEN
    RAISE EXCEPTION 'journal sequence invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO previous_receipt
    FROM release_workflow_receipts
   WHERE operation_id=p_operation_id
   ORDER BY journal_sequence DESC
   LIMIT 1;
  IF previous_receipt.id IS NULL THEN
    IF p_phase NOT IN (
      'failed_before_cutover','uncertain_before_cutover','cutover_committed','stop_committed'
    ) THEN
      RAISE EXCEPTION 'target receipt phase transition invalid' USING ERRCODE='22023';
    END IF;
  ELSIF previous_receipt.phase='cutover_committed' THEN
    IF p_phase NOT IN ('health_verified','health_failed_after_cutover','uncertain_after_cutover') THEN
      RAISE EXCEPTION 'target receipt phase transition invalid' USING ERRCODE='22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'terminal target receipt phase' USING ERRCODE='55000';
  END IF;
  IF jsonb_typeof(p_payload_json)<>'object'
     OR p_payload_json->>'schemaVersion'<>'1'
     OR p_payload_json->>'operationId' IS DISTINCT FROM p_operation_id
     OR p_payload_json->>'commandId' IS DISTINCT FROM operation.command_id
     OR p_payload_json->>'phase' IS DISTINCT FROM p_phase
     OR p_payload_json->>'ownerEpoch' IS DISTINCT FROM p_owner_epoch::text
     OR p_payload_json->>'journalSequence' IS DISTINCT FROM p_journal_sequence::text
     OR p_payload_json->>'actualPreviousReleaseVersionId' IS DISTINCT FROM p_actual_previous_release_version_id
     OR p_payload_json->>'actualCurrentReleaseVersionId' IS DISTINCT FROM p_actual_current_release_version_id THEN
    RAISE EXCEPTION 'receipt payload binding mismatch' USING ERRCODE='22023';
  END IF;
  IF p_phase IN ('cutover_committed','health_verified','health_failed_after_cutover','uncertain_after_cutover') THEN
    IF p_actual_previous_release_version_id IS DISTINCT FROM operation.expected_current_release_version_id
       OR p_actual_current_release_version_id IS DISTINCT FROM command_record.release_version_id THEN
      RAISE EXCEPTION 'receipt current binding mismatch' USING ERRCODE='22023';
    END IF;
  ELSIF p_phase IN ('failed_before_cutover','uncertain_before_cutover','stop_committed')
        AND p_actual_current_release_version_id IS DISTINCT FROM operation.expected_current_release_version_id THEN
    RAISE EXCEPTION 'pre-cutover receipt changed current' USING ERRCODE='22023';
  END IF;

  INSERT INTO release_workflow_receipts(
    id,operation_id,command_id,receipt_nonce,key_id,payload_json,payload_sha256,signature,
    phase,owner_epoch,journal_sequence,actual_previous_release_version_id,
    actual_current_release_version_id,signature_verified
  ) VALUES(
    p_id,p_operation_id,operation.command_id,p_receipt_nonce,p_key_id,p_payload_json,p_payload_sha256,
    p_signature,p_phase,p_owner_epoch,p_journal_sequence,p_actual_previous_release_version_id,
    p_actual_current_release_version_id,p_signature_verified
  );

  PERFORM release_workflow_recompute_command_projection(operation.command_id);
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_append_provider_event(
  p_id text,
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_provider_run_id text,
  p_kind text,
  p_evidence_sha256 text,
  p_metadata_json jsonb,
  p_occurred_at timestamptz
) RETURNS TABLE(event_id text,replayed boolean) AS $$
DECLARE
  run_binding release_workflow_attempts%ROWTYPE;
  state_record release_workflow_command_states%ROWTYPE;
  existing release_workflow_events%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('provider_queued','provider_in_progress','completed_success','completed_failure','completed_cancelled') THEN
    RAISE EXCEPTION 'provider event kind not allowlisted' USING ERRCODE='22023';
  END IF;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF NOT FOUND OR run_binding.provider_run_id<>p_provider_run_id THEN
    RAISE EXCEPTION 'provider run mismatch' USING ERRCODE='22023';
  END IF;
  IF run_binding.lease_owner<>p_lease_owner OR run_binding.fencing_token<>p_fencing_token THEN
    RAISE EXCEPTION 'stale provider event fence' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(p_metadata_json)<>'object'
     OR p_metadata_json->>'runId' IS DISTINCT FROM p_provider_run_id
     OR p_metadata_json->>'runAttempt' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'provider event binding mismatch' USING ERRCODE='22023';
  END IF;
  IF p_kind IN ('completed_success','completed_failure','completed_cancelled')
     AND p_metadata_json->>'conclusion' IS DISTINCT FROM (CASE p_kind
       WHEN 'completed_success' THEN 'success'
       WHEN 'completed_failure' THEN 'failure'
       WHEN 'completed_cancelled' THEN 'cancelled'
     END) THEN
    RAISE EXCEPTION 'provider conclusion mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO state_record
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=run_binding.command_id
   FOR UPDATE;
  SELECT * INTO existing FROM release_workflow_events WHERE id=p_id;
  IF FOUND THEN
    IF existing.command_id<>run_binding.command_id OR existing.attempt_key IS DISTINCT FROM p_attempt_key
       OR existing.source<>'provider' OR existing.kind<>p_kind
       OR existing.evidence_sha256<>p_evidence_sha256 OR existing.metadata_json<>p_metadata_json
       OR existing.occurred_at<>p_occurred_at THEN
      RAISE EXCEPTION 'provider event replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;

  INSERT INTO release_workflow_events(
    id,command_id,attempt_key,source,kind,evidence_sha256,metadata_json,occurred_at
  ) VALUES(
    p_id,run_binding.command_id,p_attempt_key,'provider',p_kind,p_evidence_sha256,p_metadata_json,p_occurred_at
  );
  PERFORM release_workflow_recompute_command_projection(run_binding.command_id);
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_worker_heartbeat(
  p_id text,
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_evidence_sha256 text,
  p_occurred_at timestamptz
) RETURNS TABLE(event_id text,replayed boolean) AS $$
DECLARE
  lease_record release_workflow_attempts%ROWTYPE;
  existing release_workflow_events%ROWTYPE;
  heartbeat_metadata jsonb;
BEGIN
  SELECT * INTO lease_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF NOT FOUND OR lease_record.lease_owner<>p_lease_owner
     OR lease_record.fencing_token<>p_fencing_token
     OR lease_record.lease_expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'stale heartbeat fence' USING ERRCODE='40001';
  END IF;
  heartbeat_metadata := jsonb_build_object(
    'fencingToken',p_fencing_token
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-heartbeat:' || p_id,0));
  SELECT * INTO existing FROM release_workflow_events WHERE id=p_id;
  IF FOUND THEN
    IF existing.command_id<>lease_record.command_id OR existing.attempt_key IS DISTINCT FROM p_attempt_key
       OR existing.source<>'worker' OR existing.kind<>'worker_heartbeat'
       OR existing.evidence_sha256<>p_evidence_sha256 OR existing.metadata_json<>heartbeat_metadata
       OR existing.occurred_at<>p_occurred_at THEN
      RAISE EXCEPTION 'heartbeat replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;
  INSERT INTO release_workflow_events(
    id,command_id,attempt_key,source,kind,evidence_sha256,metadata_json,occurred_at
  ) VALUES(
    p_id,lease_record.command_id,p_attempt_key,'worker','worker_heartbeat',
    p_evidence_sha256,heartbeat_metadata,p_occurred_at
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_request_stop(
  p_id text,
  p_environment text,
  p_actor_user_id text,
  p_reason text
) RETURNS TABLE(generation bigint,replayed boolean) AS $$
DECLARE
  environment_state release_workflow_environment_states%ROWTYPE;
  existing release_workflow_stops%ROWTYPE;
  next_generation bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor_user_id AND status='active') THEN
    RAISE EXCEPTION 'stop actor unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=p_environment
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release environment not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO existing FROM release_workflow_stops WHERE id=p_id;
  IF FOUND THEN
    IF existing.environment<>p_environment OR existing.action<>'requested'
       OR existing.actor_identity<>p_actor_user_id OR existing.reason<>p_reason THEN
      RAISE EXCEPTION 'stop replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.generation,true;
    RETURN;
  END IF;
  IF environment_state.stop_requested THEN
    RAISE EXCEPTION 'stop already requested' USING ERRCODE='55000';
  END IF;
  next_generation := environment_state.generation+1;
  INSERT INTO release_workflow_environment_generations(
    id,environment,generation,expected_current_release_version_id,reason,actor_kind,actor_identity
  ) VALUES(
    p_id || '-generation',p_environment,next_generation,
    environment_state.expected_current_release_version_id,p_reason,'user',p_actor_user_id
  );
  INSERT INTO release_workflow_stops(id,environment,action,generation,actor_kind,actor_identity,reason)
  VALUES(p_id,p_environment,'requested',next_generation,'user',p_actor_user_id,p_reason);
  UPDATE release_workflow_environment_states
     SET generation=next_generation,stop_requested=true,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=p_environment;
  RETURN QUERY SELECT next_generation,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_append_stop_receipt(
  p_id text,
  p_stop_id text,
  p_environment text,
  p_generation bigint,
  p_phase text,
  p_activation_id text,
  p_expected_current_release_version_id text,
  p_receipt_nonce text,
  p_key_id text,
  p_payload_json jsonb,
  p_payload_sha256 text,
  p_signature text,
  p_actor_kind text,
  p_actor_fingerprint_sha256 text,
  p_signature_verified boolean
) RETURNS TABLE(stop_receipt_id text,replayed boolean) AS $$
DECLARE
  stop_request release_workflow_stops%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  existing release_workflow_stop_receipts%ROWTYPE;
BEGIN
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=p_environment
   FOR UPDATE;
  SELECT * INTO stop_request
    FROM release_workflow_stops
   WHERE id=p_stop_id AND action='requested';
  IF NOT FOUND OR stop_request.environment<>p_environment OR stop_request.generation<>p_generation
     OR environment_state.generation<>p_generation OR NOT environment_state.stop_requested THEN
    RAISE EXCEPTION 'stop receipt binding stale' USING ERRCODE='40001';
  END IF;
  SELECT * INTO existing FROM release_workflow_stop_receipts WHERE id=p_id;
  IF FOUND THEN
    IF existing.stop_id<>p_stop_id OR existing.environment<>p_environment
       OR existing.generation<>p_generation OR existing.phase<>p_phase
       OR existing.activation_id IS DISTINCT FROM p_activation_id
       OR existing.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id
       OR existing.receipt_nonce<>p_receipt_nonce OR existing.key_id<>p_key_id
       OR existing.payload_json<>p_payload_json OR existing.payload_sha256<>p_payload_sha256
       OR existing.signature<>p_signature OR existing.actor_kind<>p_actor_kind
       OR existing.actor_fingerprint_sha256<>p_actor_fingerprint_sha256
       OR existing.signature_verified IS DISTINCT FROM p_signature_verified THEN
      RAISE EXCEPTION 'stop receipt replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;
  IF p_signature_verified IS DISTINCT FROM true
     OR p_expected_current_release_version_id IS DISTINCT FROM environment_state.expected_current_release_version_id THEN
    RAISE EXCEPTION 'stop receipt trust mismatch' USING ERRCODE='42501';
  END IF;
  IF p_phase='clear_acknowledged' THEN
    SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
    IF NOT FOUND OR activation.environment<>p_environment OR activation.expires_at<=CURRENT_TIMESTAMP
       OR activation.created_at<=stop_request.created_at THEN
      RAISE EXCEPTION 'fresh activation required' USING ERRCODE='55000';
    END IF;
  ELSIF p_phase<>'stop_committed' THEN
    RAISE EXCEPTION 'stop receipt phase invalid' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_payload_json)<>'object'
     OR p_payload_json->>'schemaVersion'<>'1'
     OR p_payload_json->>'stopId' IS DISTINCT FROM p_stop_id
     OR p_payload_json->>'environment' IS DISTINCT FROM p_environment
     OR p_payload_json->>'generation' IS DISTINCT FROM p_generation::text
     OR p_payload_json->>'phase' IS DISTINCT FROM p_phase
     OR p_payload_json->>'activationId' IS DISTINCT FROM p_activation_id
     OR p_payload_json->>'expectedCurrentReleaseVersionId' IS DISTINCT FROM p_expected_current_release_version_id THEN
    RAISE EXCEPTION 'stop receipt payload binding mismatch' USING ERRCODE='22023';
  END IF;

  INSERT INTO release_workflow_stop_receipts(
    id,stop_id,environment,generation,phase,activation_id,expected_current_release_version_id,
    receipt_nonce,key_id,payload_json,payload_sha256,signature,actor_kind,
    actor_fingerprint_sha256,signature_verified
  ) VALUES(
    p_id,p_stop_id,p_environment,p_generation,p_phase,p_activation_id,
    p_expected_current_release_version_id,p_receipt_nonce,p_key_id,p_payload_json,p_payload_sha256,
    p_signature,p_actor_kind,p_actor_fingerprint_sha256,p_signature_verified
  );
  IF p_phase='stop_committed' THEN
    INSERT INTO release_workflow_stops(
      id,environment,action,generation,actor_kind,actor_identity,reason,stop_receipt_id
    ) VALUES(
      p_id || '-fact',p_environment,'committed',p_generation,p_actor_kind,
      p_actor_fingerprint_sha256,'Target confirmed sticky stop',p_id
    );
  END IF;
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_clear_stop(
  p_id text,
  p_environment text,
  p_maker_user_id text,
  p_checker_user_id text,
  p_activation_id text,
  p_reason text
) RETURNS TABLE(generation bigint,replayed boolean) AS $$
DECLARE
  environment_state release_workflow_environment_states%ROWTYPE;
  existing release_workflow_stops%ROWTYPE;
  latest_request release_workflow_stops%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  active_lease release_workflow_attempts%ROWTYPE;
  clear_ack release_workflow_stop_receipts%ROWTYPE;
  next_generation bigint;
  actor_pair text;
BEGIN
  IF p_maker_user_id=p_checker_user_id THEN
    RAISE EXCEPTION 'dual control required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_maker_user_id AND status='active')
     OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_checker_user_id AND status='active') THEN
    RAISE EXCEPTION 'stop clear actor unavailable' USING ERRCODE='42501';
  END IF;
  actor_pair := p_maker_user_id || '|' || p_checker_user_id;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=p_environment
   FOR UPDATE;
  SELECT * INTO existing FROM release_workflow_stops WHERE id=p_id;
  IF FOUND THEN
    IF existing.environment<>p_environment OR existing.action<>'cleared'
       OR existing.actor_identity<>actor_pair OR existing.activation_id<>p_activation_id
       OR existing.reason<>p_reason THEN
      RAISE EXCEPTION 'stop clear replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.generation,true;
    RETURN;
  END IF;
  IF NOT environment_state.stop_requested THEN
    RAISE EXCEPTION 'stop is not requested' USING ERRCODE='55000';
  END IF;
  SELECT * INTO latest_request
    FROM release_workflow_stops
   WHERE release_workflow_stops.environment=p_environment AND action='requested'
   ORDER BY release_workflow_stops.generation DESC LIMIT 1;
  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  IF NOT FOUND OR activation.environment<>p_environment OR activation.expires_at<=CURRENT_TIMESTAMP
     OR activation.created_at<=latest_request.created_at THEN
    RAISE EXCEPTION 'fresh activation required' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM release_workflow_stop_receipts
     WHERE stop_id=latest_request.id AND phase='stop_committed'
       AND environment=p_environment
       AND release_workflow_stop_receipts.generation=environment_state.generation
       AND expected_current_release_version_id IS NOT DISTINCT FROM environment_state.expected_current_release_version_id
  ) THEN
    RAISE EXCEPTION 'target stop confirmation required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO clear_ack
    FROM release_workflow_stop_receipts
   WHERE stop_id=latest_request.id AND phase='clear_acknowledged';
  IF NOT FOUND OR clear_ack.environment<>p_environment
     OR clear_ack.generation<>environment_state.generation
     OR clear_ack.activation_id<>p_activation_id
     OR clear_ack.expected_current_release_version_id IS DISTINCT FROM environment_state.expected_current_release_version_id THEN
    RAISE EXCEPTION 'target clear acknowledgement required' USING ERRCODE='55000';
  END IF;
  IF environment_state.active_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'target operation still active' USING ERRCODE='55000';
  END IF;
  IF environment_state.active_attempt_key IS NOT NULL THEN
    SELECT * INTO active_lease
      FROM release_workflow_attempts
     WHERE attempt_key=environment_state.active_attempt_key AND fact_kind='leased';
    IF FOUND AND active_lease.environment_generation>=environment_state.generation THEN
      RAISE EXCEPTION 'current generation attempt still active' USING ERRCODE='55000';
    END IF;
  END IF;
  next_generation := environment_state.generation+1;
  INSERT INTO release_workflow_environment_generations(
    id,environment,generation,expected_current_release_version_id,reason,actor_kind,actor_identity
  ) VALUES(
    p_id || '-generation',p_environment,next_generation,
    environment_state.expected_current_release_version_id,p_reason,'user',actor_pair
  );
  INSERT INTO release_workflow_stops(
    id,environment,action,generation,actor_kind,actor_identity,reason,activation_id
  ) VALUES(
    p_id,p_environment,'cleared',next_generation,'user',actor_pair,p_reason,p_activation_id
  );
  UPDATE release_workflow_environment_states
     SET generation=next_generation,stop_requested=false,active_attempt_key=NULL,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=p_environment;
  RETURN QUERY SELECT next_generation,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_request_command(
  text,text,text,text,text,text,text,text,text,jsonb,text,text,bigint,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_review_command(
  text,text,text,text,text,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_record_activation(
  text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_record_first_production_enablement(
  text,text,text,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_lease_command(
  text,text,text,integer,text,text,text,text,text,text,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_bind_provider_run(
  text,text,bigint,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_append_delivery(
  text,text,text,text,text,text,integer,text,text,text,text,text,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_append_run_policy_attestation(
  text,text,text,text,integer,text,text,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_reserve_exact_run_operation(
  text,text,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_takeover_target_operation(
  text,text,bigint,bigint,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_append_target_receipt(
  text,text,text,text,jsonb,text,text,text,bigint,bigint,text,text,boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_append_provider_event(
  text,text,text,bigint,text,text,text,jsonb,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_worker_heartbeat(
  text,text,text,bigint,text,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_request_stop(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_append_stop_receipt(
  text,text,text,bigint,text,text,text,text,text,jsonb,text,text,text,text,boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_clear_stop(text,text,text,text,text,text) FROM PUBLIC;
