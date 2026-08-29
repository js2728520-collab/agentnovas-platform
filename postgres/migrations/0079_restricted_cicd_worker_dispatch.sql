-- T8.1c: narrow Worker claim/dispatch gateways.
-- The runtime remains disabled by deployment configuration. These functions
-- only close the database side of the persist-before-POST and uncertainty
-- contracts; they grant no role privileges by themselves.

ALTER TABLE release_workflow_attempts
  DROP CONSTRAINT release_workflow_attempts_fact_kind_check;
ALTER TABLE release_workflow_attempts
  ADD CONSTRAINT release_workflow_attempts_fact_kind_check CHECK (
    fact_kind IN ('leased','dispatching','run_bound','dispatch_unknown','released')
  );
ALTER TABLE release_workflow_attempts
  ADD COLUMN outcome_code text CHECK (
    outcome_code IS NULL OR outcome_code IN (
      'timeout','transport_failure','unexpected_status','malformed_response',
      'bind_commit_failure','worker_recovery'
    )
  );
ALTER TABLE release_workflow_attempts
  ADD CONSTRAINT release_workflow_attempts_outcome_shape_check CHECK (
    (fact_kind='dispatch_unknown' AND outcome_code IS NOT NULL)
    OR (fact_kind<>'dispatch_unknown' AND outcome_code IS NULL)
  );
-- A dispatch uncertainty can be learned after the original lease deadline.
-- Preserve the historical deadline instead of forging a lease extension; only
-- the lease fact itself must have been created before that deadline.
ALTER TABLE release_workflow_attempts
  DROP CONSTRAINT release_workflow_attempts_check;
ALTER TABLE release_workflow_attempts
  ADD CONSTRAINT release_workflow_attempts_check CHECK (
    fact_kind<>'leased' OR lease_expires_at>created_at
  );

CREATE TABLE release_workflow_provider_bindings (
  provider_binding_sha256 text PRIMARY KEY CHECK (provider_binding_sha256 ~ '^[a-f0-9]{64}$'),
  material_json jsonb NOT NULL CHECK (
    jsonb_typeof(material_json)='object'
    AND material_json=jsonb_build_object(
      'provider',material_json->>'provider',
      'apiVersion',material_json->>'apiVersion',
      'apiBaseUrl',material_json->>'apiBaseUrl',
      'repositoryOwner',material_json->>'repositoryOwner',
      'repositoryName',material_json->>'repositoryName',
      'repositoryId',material_json->>'repositoryId',
      'appId',material_json->>'appId',
      'installationId',material_json->>'installationId',
      'accountId',material_json->>'accountId',
      'workflowId',material_json->>'workflowId',
      'workflowPath',material_json->>'workflowPath',
      'workflowControlRef',material_json->>'workflowControlRef',
      'controlCommitSha',material_json->>'controlCommitSha',
      'workflowSha256',material_json->>'workflowSha256',
      'oidcAudience',material_json->>'oidcAudience',
      'runnerEnvironment',material_json->>'runnerEnvironment'
    )
    AND material_json->>'provider'='github_actions'
    AND material_json->>'apiVersion'='2026-03-10'
    AND material_json->>'apiBaseUrl'='https://api.github.com'
    AND material_json->>'repositoryOwner' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND material_json->>'repositoryName' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND material_json->>'repositoryId' ~ '^[1-9][0-9]{0,15}$'
    AND material_json->>'appId' ~ '^[1-9][0-9]{0,15}$'
    AND material_json->>'installationId' ~ '^[1-9][0-9]{0,15}$'
    AND material_json->>'accountId' ~ '^[1-9][0-9]{0,15}$'
    AND material_json->>'workflowId' ~ '^[1-9][0-9]{0,15}$'
    AND material_json->>'workflowPath' ~ '^\.github/workflows/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ya?ml$'
    AND material_json->>'workflowControlRef' ~ '^refs/tags/.{1,198}$'
    AND material_json->>'controlCommitSha' ~ '^[a-f0-9]{40}$'
    AND material_json->>'workflowSha256' ~ '^[a-f0-9]{64}$'
    AND material_json->>'oidcAudience' ~ '^https://'
    AND material_json->>'runnerEnvironment' IN ('github-hosted','self-hosted')
  ),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_release_workflow_provider_bindings_immutable
  BEFORE UPDATE OR DELETE ON release_workflow_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION protect_release_workflow_fact_immutable();
ALTER TABLE release_workflow_provider_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE release_workflow_provider_bindings FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_record_provider_binding(
  p_provider_binding_sha256 text,
  p_material_json jsonb
) RETURNS TABLE(provider_binding_sha256 text,replayed boolean) AS $$
DECLARE
  existing release_workflow_provider_bindings%ROWTYPE;
  was_inserted boolean := false;
BEGIN
  -- The table constraints validate the closed material schema. Runtime claim
  -- additionally requires byte-equivalent jsonb material, so the digest can
  -- never redirect a Worker to different repository coordinates.
  INSERT INTO release_workflow_provider_bindings(provider_binding_sha256,material_json)
  VALUES(p_provider_binding_sha256,p_material_json)
  ON CONFLICT DO NOTHING
  RETURNING true INTO was_inserted;
  SELECT * INTO existing
    FROM release_workflow_provider_bindings AS stored
   WHERE stored.provider_binding_sha256=p_provider_binding_sha256;
  IF NOT FOUND OR existing.material_json<>p_material_json THEN
    RAISE EXCEPTION 'provider binding replay mismatch' USING ERRCODE='23505';
  END IF;
  RETURN QUERY SELECT existing.provider_binding_sha256,NOT was_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_claim_next_command(
  p_attempt_key text,
  p_lease_owner text,
  p_lease_seconds integer,
  p_g7_manifest_sha256 text,
  p_provider_binding_sha256 text,
  p_environment_policy_sha256 text,
  p_runner_policy_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_auditor_trust_sha256 text,
  p_reviewer_allowlist_sha256 text,
  p_provider_binding_material jsonb
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
  activation_id text,
  replayed boolean
) AS $$
DECLARE
  existing release_workflow_attempts%ROWTYPE;
  candidate release_workflow_commands%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  provider_binding release_workflow_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO provider_binding
    FROM release_workflow_provider_bindings
   WHERE provider_binding_sha256=p_provider_binding_sha256;
  IF NOT FOUND OR provider_binding.material_json<>p_provider_binding_material THEN
    RAISE EXCEPTION 'claim provider binding mismatch' USING ERRCODE='22023';
  END IF;
  IF provider_binding.material_json->>'workflowSha256' IS DISTINCT FROM
     p_provider_binding_material->>'workflowSha256' THEN
    RAISE EXCEPTION 'claim workflow binding mismatch' USING ERRCODE='22023';
  END IF;
  IF EXISTS(
    SELECT 1
      FROM release_workflow_attempts AS dispatching
      JOIN release_workflow_command_states AS state
        ON state.command_id=dispatching.command_id
     WHERE dispatching.fact_kind='dispatching'
       AND dispatching.lease_expires_at<=CURRENT_TIMESTAMP
       AND state.current_attempt_key=dispatching.attempt_key
       AND state.status='dispatching'
       AND NOT EXISTS(
         SELECT 1 FROM release_workflow_attempts AS terminal
          WHERE terminal.attempt_key=dispatching.attempt_key
            AND terminal.fact_kind IN ('run_bound','dispatch_unknown')
       )
  ) THEN
    RAISE EXCEPTION 'expired dispatch recovery required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO existing
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key
     AND fact_kind='leased';
  IF FOUND THEN
    SELECT * INTO activation
      FROM release_workflow_activations
     WHERE id=existing.activation_id;
    IF NOT FOUND
       OR activation.g7_manifest_sha256<>p_g7_manifest_sha256
       OR activation.provider_binding_sha256<>p_provider_binding_sha256
       OR activation.environment_policy_sha256<>p_environment_policy_sha256
       OR activation.runner_policy_sha256<>p_runner_policy_sha256
       OR activation.target_binding_sha256<>p_target_binding_sha256
       OR activation.receipt_trust_sha256<>p_receipt_trust_sha256
       OR activation.auditor_trust_sha256<>p_auditor_trust_sha256
       OR activation.reviewer_allowlist_sha256<>p_reviewer_allowlist_sha256
       OR activation.workflow_sha256<>provider_binding.material_json->>'workflowSha256' THEN
      RAISE EXCEPTION 'claim binding mismatch' USING ERRCODE='22023';
    END IF;
    RETURN QUERY
    SELECT
      leased.attempt_key,leased.fencing_token,leased.command_id,leased.release_version_id,
      leased.environment,leased.action,leased.snapshot_sha256,leased.artifact_manifest_sha256,
      leased.workflow_sha256,leased.environment_generation,
      leased.expected_current_release_version_id,leased.lease_expires_at,
      activation.id,leased.replayed
    FROM release_workflow_lease_command(
      p_attempt_key,existing.command_id,p_lease_owner,p_lease_seconds,activation.id,
      p_g7_manifest_sha256,p_provider_binding_sha256,p_environment_policy_sha256,
      p_runner_policy_sha256,p_target_binding_sha256,p_receipt_trust_sha256,
      p_auditor_trust_sha256,p_reviewer_allowlist_sha256
    ) AS leased;
    RETURN;
  END IF;

  SELECT command.* INTO candidate
    FROM release_workflow_command_states AS state
    JOIN release_workflow_commands AS command ON command.id=state.command_id
    JOIN release_workflow_approvals AS approval ON approval.command_id=command.id
   WHERE state.status='approved'
     AND approval.decision='approve'
     AND approval.snapshot_sha256=command.snapshot_sha256
     AND approval.expires_at>CURRENT_TIMESTAMP
     AND EXISTS(
       SELECT 1
         FROM release_workflow_activations AS available_activation
        WHERE available_activation.environment=command.environment
          AND available_activation.artifact_manifest_sha256=command.artifact_manifest_sha256
          AND available_activation.workflow_sha256=command.workflow_sha256
          AND available_activation.g7_manifest_sha256=p_g7_manifest_sha256
          AND available_activation.provider_binding_sha256=p_provider_binding_sha256
          AND available_activation.environment_policy_sha256=p_environment_policy_sha256
          AND available_activation.runner_policy_sha256=p_runner_policy_sha256
          AND available_activation.target_binding_sha256=p_target_binding_sha256
          AND available_activation.receipt_trust_sha256=p_receipt_trust_sha256
          AND available_activation.auditor_trust_sha256=p_auditor_trust_sha256
          AND available_activation.reviewer_allowlist_sha256=p_reviewer_allowlist_sha256
          AND available_activation.workflow_sha256=provider_binding.material_json->>'workflowSha256'
          AND available_activation.expires_at>CURRENT_TIMESTAMP
     )
   ORDER BY command.created_at,command.id
   FOR UPDATE OF state SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO activation
    FROM release_workflow_activations AS available_activation
   WHERE available_activation.environment=candidate.environment
     AND available_activation.artifact_manifest_sha256=candidate.artifact_manifest_sha256
     AND available_activation.workflow_sha256=candidate.workflow_sha256
     AND available_activation.g7_manifest_sha256=p_g7_manifest_sha256
     AND available_activation.provider_binding_sha256=p_provider_binding_sha256
     AND available_activation.environment_policy_sha256=p_environment_policy_sha256
     AND available_activation.runner_policy_sha256=p_runner_policy_sha256
     AND available_activation.target_binding_sha256=p_target_binding_sha256
     AND available_activation.receipt_trust_sha256=p_receipt_trust_sha256
     AND available_activation.auditor_trust_sha256=p_auditor_trust_sha256
     AND available_activation.reviewer_allowlist_sha256=p_reviewer_allowlist_sha256
     AND available_activation.workflow_sha256=provider_binding.material_json->>'workflowSha256'
     AND available_activation.expires_at>CURRENT_TIMESTAMP
   ORDER BY available_activation.created_at DESC,available_activation.id DESC
   LIMIT 1;

  RETURN QUERY
  SELECT
    leased.attempt_key,leased.fencing_token,leased.command_id,leased.release_version_id,
    leased.environment,leased.action,leased.snapshot_sha256,leased.artifact_manifest_sha256,
    leased.workflow_sha256,leased.environment_generation,
    leased.expected_current_release_version_id,leased.lease_expires_at,
    activation.id,leased.replayed
  FROM release_workflow_lease_command(
    p_attempt_key,candidate.id,p_lease_owner,p_lease_seconds,activation.id,
    p_g7_manifest_sha256,p_provider_binding_sha256,p_environment_policy_sha256,
    p_runner_policy_sha256,p_target_binding_sha256,p_receipt_trust_sha256,
    p_auditor_trust_sha256,p_reviewer_allowlist_sha256
  ) AS leased;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_begin_dispatch(
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_dispatch_request_sha256 text
) RETURNS TABLE(dispatch_request_sha256 text,replayed boolean) AS $$
DECLARE
  lease_record release_workflow_attempts%ROWTYPE;
  existing release_workflow_attempts%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
BEGIN
  SELECT * INTO lease_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF NOT FOUND THEN RAISE EXCEPTION 'lease not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO existing
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='dispatching';
  IF FOUND THEN
    IF existing.lease_owner<>p_lease_owner OR existing.fencing_token<>p_fencing_token
       OR existing.dispatch_request_sha256<>p_dispatch_request_sha256 THEN
      RAISE EXCEPTION 'dispatch replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.dispatch_request_sha256,true;
    RETURN;
  END IF;

  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=lease_record.environment
   FOR UPDATE;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=lease_record.command_id
   FOR UPDATE;
  IF lease_record.lease_owner<>p_lease_owner OR lease_record.fencing_token<>p_fencing_token
     OR lease_record.lease_expires_at<=CURRENT_TIMESTAMP
     OR environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key
     OR environment_state.generation<>lease_record.environment_generation
     OR environment_state.stop_requested OR environment_state.blocked
     OR command_state.current_attempt_key IS DISTINCT FROM p_attempt_key
     OR command_state.status<>'leased' THEN
    RAISE EXCEPTION 'stale dispatch fence' USING ERRCODE='40001';
  END IF;

  INSERT INTO release_workflow_attempts(
    id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
    environment_generation,snapshot_sha256,lease_expires_at,dispatch_request_sha256
  ) VALUES(
    p_attempt_key || '-dispatching',p_attempt_key,lease_record.command_id,lease_record.activation_id,
    lease_record.environment,'dispatching',lease_record.lease_owner,lease_record.fencing_token,
    lease_record.environment_generation,lease_record.snapshot_sha256,lease_record.lease_expires_at,
    p_dispatch_request_sha256
  );
  UPDATE release_workflow_command_states
     SET status='dispatching',updated_at=CURRENT_TIMESTAMP
   WHERE command_id=lease_record.command_id AND current_attempt_key=p_attempt_key;
  RETURN QUERY SELECT p_dispatch_request_sha256,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_record_dispatch_unknown(
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_dispatch_request_sha256 text,
  p_outcome_code text
) RETURNS TABLE(recorded boolean,provider_run_id text,replayed boolean) AS $$
DECLARE
  lease_record release_workflow_attempts%ROWTYPE;
  dispatch_record release_workflow_attempts%ROWTYPE;
  bound_run release_workflow_attempts%ROWTYPE;
  existing release_workflow_attempts%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
BEGIN
  IF p_outcome_code NOT IN (
    'timeout','transport_failure','unexpected_status','malformed_response',
    'bind_commit_failure','worker_recovery'
  ) THEN
    RAISE EXCEPTION 'dispatch outcome code invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO lease_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF NOT FOUND THEN RAISE EXCEPTION 'lease not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO dispatch_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='dispatching';
  IF NOT FOUND OR dispatch_record.dispatch_request_sha256<>p_dispatch_request_sha256 THEN
    RAISE EXCEPTION 'dispatch was not persisted' USING ERRCODE='55000';
  END IF;
  IF lease_record.lease_owner<>p_lease_owner OR lease_record.fencing_token<>p_fencing_token THEN
    RAISE EXCEPTION 'stale dispatch fence' USING ERRCODE='40001';
  END IF;

  SELECT * INTO bound_run
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF FOUND THEN
    RETURN QUERY SELECT false,bound_run.provider_run_id,false;
    RETURN;
  END IF;
  SELECT * INTO existing
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='dispatch_unknown';
  IF FOUND THEN
    IF existing.lease_owner<>p_lease_owner OR existing.fencing_token<>p_fencing_token
       OR existing.dispatch_request_sha256<>p_dispatch_request_sha256
       OR existing.outcome_code<>p_outcome_code THEN
      RAISE EXCEPTION 'dispatch uncertainty replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT true,NULL::text,true;
    RETURN;
  END IF;

  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=lease_record.environment
   FOR UPDATE;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=lease_record.command_id
   FOR UPDATE;
  IF environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key
     OR command_state.current_attempt_key IS DISTINCT FROM p_attempt_key
     OR command_state.status<>'dispatching' THEN
    RAISE EXCEPTION 'stale dispatch uncertainty fence' USING ERRCODE='40001';
  END IF;

  INSERT INTO release_workflow_attempts(
    id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
    environment_generation,snapshot_sha256,lease_expires_at,dispatch_request_sha256,outcome_code
  ) VALUES(
    p_attempt_key || '-dispatch-unknown',p_attempt_key,lease_record.command_id,lease_record.activation_id,
    lease_record.environment,'dispatch_unknown',lease_record.lease_owner,lease_record.fencing_token,
    lease_record.environment_generation,lease_record.snapshot_sha256,lease_record.lease_expires_at,
    p_dispatch_request_sha256,p_outcome_code
  );
  UPDATE release_workflow_command_states
     SET status='manual_intervention',dispatch_outcome_unknown=true,updated_at=CURRENT_TIMESTAMP
   WHERE command_id=lease_record.command_id AND current_attempt_key=p_attempt_key;
  UPDATE release_workflow_environment_states
     SET blocked=true,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=lease_record.environment
     AND active_attempt_key=p_attempt_key;
  RETURN QUERY SELECT true,NULL::text,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_recover_expired_dispatch()
RETURNS TABLE(attempt_key text,command_id text) AS $$
DECLARE
  dispatch_record release_workflow_attempts%ROWTYPE;
  result record;
BEGIN
  SELECT dispatching.* INTO dispatch_record
    FROM release_workflow_attempts AS dispatching
    JOIN release_workflow_command_states AS state
      ON state.command_id=dispatching.command_id
    JOIN release_workflow_environment_states AS environment_state
      ON environment_state.environment=dispatching.environment
   WHERE dispatching.fact_kind='dispatching'
     AND dispatching.lease_expires_at<=CURRENT_TIMESTAMP
     AND state.current_attempt_key=dispatching.attempt_key
     AND state.status='dispatching'
     AND environment_state.active_attempt_key=dispatching.attempt_key
     AND NOT EXISTS(
       SELECT 1 FROM release_workflow_attempts AS terminal
        WHERE terminal.attempt_key=dispatching.attempt_key
          AND terminal.fact_kind IN ('run_bound','dispatch_unknown')
     )
   ORDER BY dispatching.created_at,dispatching.attempt_key
   FOR UPDATE OF state,environment_state SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO result FROM release_workflow_record_dispatch_unknown(
    dispatch_record.attempt_key,
    dispatch_record.lease_owner,
    dispatch_record.fencing_token,
    dispatch_record.dispatch_request_sha256,
    'worker_recovery'
  );
  IF NOT result.recorded THEN
    RAISE EXCEPTION 'expired dispatch recovery failed' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT dispatch_record.attempt_key,dispatch_record.command_id;
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
  dispatch_record release_workflow_attempts%ROWTYPE;
  unknown_record release_workflow_attempts%ROWTYPE;
  existing release_workflow_attempts%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
  provider_binding release_workflow_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO lease_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='leased';
  IF NOT FOUND THEN RAISE EXCEPTION 'lease not found' USING ERRCODE='P0002'; END IF;
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
  SELECT * INTO unknown_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='dispatch_unknown';
  IF FOUND THEN RAISE EXCEPTION 'dispatch outcome unknown' USING ERRCODE='55000'; END IF;
  SELECT * INTO dispatch_record
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='dispatching';
  IF NOT FOUND OR dispatch_record.dispatch_request_sha256<>p_dispatch_request_sha256 THEN
    RAISE EXCEPTION 'dispatch was not persisted' USING ERRCODE='55000';
  END IF;

  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=lease_record.environment
   FOR UPDATE;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=lease_record.command_id
   FOR UPDATE;
  IF lease_record.lease_owner<>p_lease_owner OR lease_record.fencing_token<>p_fencing_token
     OR lease_record.lease_expires_at<=CURRENT_TIMESTAMP
     OR environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key
     OR environment_state.generation<>lease_record.environment_generation
     OR environment_state.stop_requested OR environment_state.blocked
     OR command_state.current_attempt_key IS DISTINCT FROM p_attempt_key
     OR command_state.status<>'dispatching' THEN
    RAISE EXCEPTION 'stale lease fence' USING ERRCODE='40001';
  END IF;
  SELECT binding.* INTO provider_binding
    FROM release_workflow_activations AS activation
    JOIN release_workflow_provider_bindings AS binding
      ON binding.provider_binding_sha256=activation.provider_binding_sha256
   WHERE activation.id=lease_record.activation_id;
  IF NOT FOUND OR p_provider_run_url<>format(
    'https://github.com/%s/%s/actions/runs/%s',
    provider_binding.material_json->>'repositoryOwner',
    provider_binding.material_json->>'repositoryName',
    p_provider_run_id
  ) THEN
    RAISE EXCEPTION 'provider run url mismatch' USING ERRCODE='22023';
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

CREATE OR REPLACE FUNCTION release_workflow_reject_bound_run(
  p_id text,
  p_attempt_key text,
  p_lease_owner text,
  p_fencing_token bigint,
  p_provider_run_id text,
  p_evidence_sha256 text,
  p_reason_code text
) RETURNS TABLE(event_id text,replayed boolean) AS $$
DECLARE
  run_binding release_workflow_attempts%ROWTYPE;
  existing release_workflow_events%ROWTYPE;
  command_state release_workflow_command_states%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  metadata jsonb;
BEGIN
  IF p_reason_code NOT IN ('exact_run_mismatch','exact_run_verification_unavailable') THEN
    RAISE EXCEPTION 'bound run rejection reason invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE release_workflow_attempts.attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF NOT FOUND OR run_binding.provider_run_id<>p_provider_run_id THEN
    RAISE EXCEPTION 'provider run mismatch' USING ERRCODE='22023';
  END IF;
  IF run_binding.lease_owner<>p_lease_owner OR run_binding.fencing_token<>p_fencing_token THEN
    RAISE EXCEPTION 'stale provider run fence' USING ERRCODE='40001';
  END IF;
  metadata := jsonb_build_object(
    'runId',p_provider_run_id,'runAttempt',1,'reasonCode',p_reason_code
  );
  SELECT * INTO existing FROM release_workflow_events WHERE id=p_id;
  IF FOUND THEN
    IF existing.command_id<>run_binding.command_id
       OR existing.attempt_key IS DISTINCT FROM p_attempt_key
       OR existing.source<>'worker' OR existing.kind<>'exact_run_rejected'
       OR existing.evidence_sha256<>p_evidence_sha256 OR existing.metadata_json<>metadata THEN
      RAISE EXCEPTION 'bound run rejection replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true;
    RETURN;
  END IF;
  IF EXISTS(
    SELECT 1 FROM release_workflow_authorizations
     WHERE release_workflow_authorizations.command_id=run_binding.command_id
  ) THEN
    RAISE EXCEPTION 'target authorization already exists' USING ERRCODE='55000';
  END IF;
  SELECT * INTO command_state
    FROM release_workflow_command_states
   WHERE release_workflow_command_states.command_id=run_binding.command_id
   FOR UPDATE;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE release_workflow_environment_states.environment=run_binding.environment
   FOR UPDATE;
  IF command_state.current_attempt_key IS DISTINCT FROM p_attempt_key
     OR command_state.status<>'dispatch_accepted'
     OR environment_state.active_attempt_key IS DISTINCT FROM p_attempt_key THEN
    RAISE EXCEPTION 'stale provider run rejection fence' USING ERRCODE='40001';
  END IF;

  INSERT INTO release_workflow_events(
    id,command_id,attempt_key,source,kind,evidence_sha256,metadata_json,occurred_at
  ) VALUES(
    p_id,run_binding.command_id,p_attempt_key,'worker','exact_run_rejected',
    p_evidence_sha256,metadata,CURRENT_TIMESTAMP
  );
  UPDATE release_workflow_command_states
     SET status='manual_intervention',updated_at=CURRENT_TIMESTAMP
   WHERE command_id=run_binding.command_id AND current_attempt_key=p_attempt_key;
  UPDATE release_workflow_environment_states
     SET blocked=true,updated_at=CURRENT_TIMESTAMP
   WHERE release_workflow_environment_states.environment=run_binding.environment
     AND active_attempt_key=p_attempt_key;
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_claim_next_command(
  text,text,integer,text,text,text,text,text,text,text,text,jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_record_provider_binding(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_begin_dispatch(text,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_record_dispatch_unknown(text,text,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_recover_expired_dispatch() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_reject_bound_run(text,text,text,bigint,text,text,text) FROM PUBLIC;
