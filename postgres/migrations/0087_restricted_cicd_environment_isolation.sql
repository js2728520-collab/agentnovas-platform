-- T8.2d2: make the provider binding, dispatch lease, reconciliation and
-- uncertain-dispatch recovery environment-specific. Staging and production
-- processes can share the database without sharing authority or failure scope.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM release_workflow_provider_bindings
     WHERE NOT (material_json ? 'environment')
  ) THEN
    RAISE EXCEPTION 'legacy provider bindings must be retired before environment isolation';
  END IF;
END
$$;

ALTER TABLE release_workflow_provider_bindings
  DROP CONSTRAINT release_workflow_provider_bindings_material_json_check;
ALTER TABLE release_workflow_provider_bindings
  ADD CONSTRAINT release_workflow_provider_bindings_material_json_check CHECK (
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
      'environment',material_json->>'environment',
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
    AND material_json->>'environment' IN ('staging','production')
    AND material_json->>'oidcAudience' ~ '^https://'
    AND material_json->>'runnerEnvironment' IN ('github-hosted','self-hosted')
  );

CREATE OR REPLACE FUNCTION release_workflow_recover_expired_dispatch_v2(
  p_environment text
) RETURNS TABLE(attempt_key text,command_id text) AS $$
DECLARE
  dispatch_record release_workflow_attempts%ROWTYPE;
  result record;
BEGIN
  IF p_environment NOT IN ('staging','production') THEN
    RAISE EXCEPTION 'invalid recovery environment' USING ERRCODE='22023';
  END IF;
  SELECT dispatching.* INTO dispatch_record
    FROM release_workflow_attempts AS dispatching
    JOIN release_workflow_command_states AS state
      ON state.command_id=dispatching.command_id
    JOIN release_workflow_environment_states AS environment_state
      ON environment_state.environment=dispatching.environment
   WHERE dispatching.fact_kind='dispatching'
     AND dispatching.environment=p_environment
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

CREATE OR REPLACE FUNCTION release_workflow_claim_next_command_v2(
  p_attempt_key text,
  p_lease_owner text,
  p_lease_seconds integer,
  p_environment text,
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
  IF p_environment NOT IN ('staging','production')
     OR p_provider_binding_material->>'environment' IS DISTINCT FROM p_environment THEN
    RAISE EXCEPTION 'claim environment binding mismatch' USING ERRCODE='22023';
  END IF;
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
       AND dispatching.environment=p_environment
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
    IF existing.environment<>p_environment THEN
      RAISE EXCEPTION 'claim environment binding mismatch' USING ERRCODE='22023';
    END IF;
    SELECT * INTO activation
      FROM release_workflow_activations
     WHERE id=existing.activation_id AND environment=p_environment;
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
     AND command.environment=p_environment
     AND approval.decision='approve'
     AND approval.snapshot_sha256=command.snapshot_sha256
     AND approval.expires_at>CURRENT_TIMESTAMP
     AND EXISTS(
       SELECT 1
         FROM release_workflow_activations AS available_activation
        WHERE available_activation.environment=p_environment
          AND available_activation.environment=command.environment
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
   WHERE available_activation.environment=p_environment
     AND available_activation.environment=candidate.environment
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

CREATE OR REPLACE FUNCTION release_workflow_claim_next_reconciliation_v2(
  p_environment text,
  p_provider_binding_sha256 text,
  p_provider_binding_material jsonb
) RETURNS TABLE(
  attempt_key text,
  command_id text,
  lease_owner text,
  fencing_token bigint,
  provider_run_id text
) AS $$
DECLARE
  provider_binding release_workflow_provider_bindings%ROWTYPE;
BEGIN
  IF p_environment NOT IN ('staging','production')
     OR p_provider_binding_material->>'environment' IS DISTINCT FROM p_environment THEN
    RAISE EXCEPTION 'reconciliation environment binding mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO provider_binding
    FROM release_workflow_provider_bindings AS binding
   WHERE binding.provider_binding_sha256=p_provider_binding_sha256;
  IF NOT FOUND OR provider_binding.material_json<>p_provider_binding_material THEN
    RAISE EXCEPTION 'reconciliation provider binding mismatch' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT
    run_binding.attempt_key,
    run_binding.command_id,
    run_binding.lease_owner,
    run_binding.fencing_token,
    run_binding.provider_run_id
  FROM release_workflow_attempts AS run_binding
  JOIN release_workflow_activations AS activation ON activation.id=run_binding.activation_id
  JOIN release_workflow_command_states AS state ON state.command_id=run_binding.command_id
  LEFT JOIN LATERAL (
    SELECT max(event.received_at) AS received_at
      FROM release_workflow_events AS event
     WHERE event.command_id=run_binding.command_id
       AND event.source='provider'
  ) AS last_event ON true
  WHERE run_binding.fact_kind='run_bound'
    AND run_binding.environment=p_environment
    AND activation.environment=p_environment
    AND activation.provider_binding_sha256=p_provider_binding_sha256
    AND activation.workflow_sha256=provider_binding.material_json->>'workflowSha256'
    AND state.current_attempt_key=run_binding.attempt_key
    AND state.status IN ('dispatch_accepted','waiting_authorization','running','settling')
    AND NOT state.dispatch_outcome_unknown
    AND NOT state.provider_state_unknown
    AND NOT EXISTS (
      SELECT 1
        FROM release_workflow_events AS terminal_event
       WHERE terminal_event.command_id=run_binding.command_id
         AND terminal_event.source='provider'
         AND terminal_event.kind IN ('completed_success','completed_failure','completed_cancelled')
    )
  ORDER BY COALESCE(last_event.received_at,run_binding.created_at),run_binding.created_at,run_binding.attempt_key
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_recover_expired_dispatch_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_claim_next_command_v2(
  text,text,integer,text,text,text,text,text,text,text,text,text,jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workflow_claim_next_reconciliation_v2(text,text,jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_release_worker') THEN
    REVOKE EXECUTE ON FUNCTION release_workflow_recover_expired_dispatch() FROM agentnovas_release_worker;
    REVOKE EXECUTE ON FUNCTION release_workflow_claim_next_command(
      text,text,integer,text,text,text,text,text,text,text,text,jsonb
    ) FROM agentnovas_release_worker;
    REVOKE EXECUTE ON FUNCTION release_workflow_claim_next_reconciliation(text,jsonb) FROM agentnovas_release_worker;
  END IF;
END
$$;
