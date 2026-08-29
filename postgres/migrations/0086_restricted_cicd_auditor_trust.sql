-- Bind the independently custodied Auditor trust policy to the exact activation
-- before delegating to the v3 server-derived reservation. The v3 function remains
-- an owner-internal implementation detail and is never granted to a runtime role.

CREATE OR REPLACE FUNCTION release_workflow_reserve_workflow_target_request_v4(
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
  p_receipt_trust_sha256 text,
  p_auditor_trust_sha256 text
) RETURNS TABLE(operation_id text,owner_epoch bigint,replayed boolean,execution_snapshot jsonb) AS $$
DECLARE
  activation_auditor_trust_sha256 text;
BEGIN
  IF p_auditor_trust_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'workflow target auditor trust invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('release-workflow-target-v4:'||p_command_id,0));
  SELECT activation.auditor_trust_sha256
    INTO activation_auditor_trust_sha256
    FROM release_workflow_attempts attempt
    JOIN release_workflow_activations activation ON activation.id=attempt.activation_id
   WHERE attempt.command_id=p_command_id
     AND attempt.fact_kind='run_bound'
     AND attempt.provider_run_id=p_provider_run_id
     AND attempt.provider_run_attempt=1;
  IF NOT FOUND OR activation_auditor_trust_sha256<>p_auditor_trust_sha256 THEN
    RAISE EXCEPTION 'workflow target auditor trust mismatch' USING ERRCODE='22023';
  END IF;

  RETURN QUERY SELECT * FROM release_workflow_reserve_workflow_target_request_v3(
    p_command_id,p_release_version_id,p_provider_run_id,p_job_id,p_environment,p_action,
    p_artifact_manifest_sha256,p_environment_generation,p_control_commit_sha,p_oidc_jti_sha256,
    p_target_owner_identity_sha256,p_target_owner_evidence_sha256,p_target_binding_sha256,
    p_receipt_trust_sha256
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_reserve_workflow_target_request_v4(
  text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,text
) FROM PUBLIC;
