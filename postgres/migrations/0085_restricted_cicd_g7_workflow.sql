-- T8.2d: the GitHub Runner submits only the seven frozen dispatch inputs plus
-- its ephemeral OIDC context.  All authorization, attestation and operation
-- identifiers are selected or derived inside the database-owned trust boundary.

CREATE OR REPLACE FUNCTION release_workflow_reserve_workflow_target_request_v3(
  p_command_id text,
  p_release_version_id text,
  p_provider_run_id text,
  p_job_id text,
  p_environment text,
  p_action text,
  p_artifact_manifest_sha256 text,
  p_environment_generation bigint,
  p_control_commit_sha text,
  p_oidc_jti_sha256 text,
  p_target_owner_identity_sha256 text,
  p_target_owner_evidence_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(operation_id text,owner_epoch bigint,replayed boolean,execution_snapshot jsonb) AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  approval release_workflow_approvals%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  attestation release_workflow_run_policy_attestations%ROWTYPE;
  attestation_count integer;
  authorization_id text;
  target_operation_id text;
  authorization_nonce text;
  authorization_expires_at timestamptz;
  reservation record;
  identity_digest text;
BEGIN
  IF p_provider_run_id !~ '^[1-9][0-9]{0,19}$'
     OR p_job_id !~ '^[1-9][0-9]{0,19}$'
     OR p_environment NOT IN ('staging','production')
     OR p_action NOT IN ('deploy','rollback')
     OR p_artifact_manifest_sha256 !~ '^[a-f0-9]{64}$'
     OR p_environment_generation<1
     OR p_control_commit_sha !~ '^[a-f0-9]{40}$'
     OR p_oidc_jti_sha256 !~ '^[a-f0-9]{64}$'
     OR p_target_owner_identity_sha256 !~ '^[a-f0-9]{64}$'
     OR p_target_owner_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR p_target_binding_sha256 !~ '^[a-f0-9]{64}$'
     OR p_receipt_trust_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'workflow target request invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-target-v3:'||p_command_id,0));
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  IF NOT FOUND
     OR command_record.release_version_id<>p_release_version_id
     OR command_record.environment<>p_environment
     OR command_record.action<>p_action
     OR command_record.artifact_manifest_sha256<>p_artifact_manifest_sha256
     OR command_record.environment_generation<>p_environment_generation
     OR command_record.snapshot_json->>'controlCommitSha'<>p_control_commit_sha THEN
    RAISE EXCEPTION 'workflow target command binding mismatch' USING ERRCODE='22023';
  END IF;

  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE command_id=p_command_id AND fact_kind='run_bound'
     AND provider_run_id=p_provider_run_id AND provider_run_attempt=1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow target exact run unavailable' USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer INTO attestation_count
    FROM release_workflow_run_policy_attestations
   WHERE run_id=p_provider_run_id AND run_attempt=1 AND job_id=p_job_id
     AND environment=p_environment AND oidc_jti_sha256=p_oidc_jti_sha256
     AND expires_at>CURRENT_TIMESTAMP;
  IF attestation_count<>1 THEN
    RAISE EXCEPTION 'workflow target attestation unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO attestation
    FROM release_workflow_run_policy_attestations
   WHERE run_id=p_provider_run_id AND run_attempt=1 AND job_id=p_job_id
     AND environment=p_environment AND oidc_jti_sha256=p_oidc_jti_sha256
     AND expires_at>CURRENT_TIMESTAMP;
  SELECT * INTO approval FROM release_workflow_approvals WHERE command_id=p_command_id;
  SELECT * INTO activation FROM release_workflow_activations WHERE id=run_binding.activation_id;
  IF approval.id IS NULL OR activation.id IS NULL THEN
    RAISE EXCEPTION 'workflow target authorization facts unavailable' USING ERRCODE='55000';
  END IF;

  identity_digest:=encode(sha256(convert_to(concat_ws(chr(31),
    'restricted-cicd-workflow-target-v3',p_command_id,p_provider_run_id,p_job_id,p_oidc_jti_sha256
  ),'UTF8')),'hex');
  authorization_id:='authorization-v3-'||substr(identity_digest,1,48);
  target_operation_id:='operation-v3-'||substr(identity_digest,1,48);
  authorization_nonce:='nonce-v3-'||substr(identity_digest,1,48);
  authorization_expires_at:=LEAST(
    attestation.expires_at,approval.expires_at,activation.expires_at,run_binding.lease_expires_at
  );
  IF authorization_expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'workflow target authorization expired' USING ERRCODE='55000';
  END IF;

  SELECT * INTO reservation FROM release_workflow_reserve_exact_target_request_v2(
    authorization_id,target_operation_id,p_command_id,run_binding.attempt_key,attestation.id,
    p_provider_run_id,p_environment,p_action,command_record.snapshot_sha256,
    p_artifact_manifest_sha256,command_record.workflow_sha256,p_environment_generation,
    command_record.expected_current_release_version_id,p_oidc_jti_sha256,authorization_nonce,
    p_target_owner_identity_sha256,p_target_owner_evidence_sha256,p_target_binding_sha256,
    p_receipt_trust_sha256,authorization_expires_at
  );
  RETURN QUERY SELECT reservation.operation_id,reservation.owner_epoch,reservation.replayed,
    reservation.execution_snapshot;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_reserve_workflow_target_request_v3(
  text,text,text,text,text,text,text,bigint,text,text,text,text,text,text
) FROM PUBLIC;
