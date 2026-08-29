-- T8.2b1: bind the strict target deployment request to the immutable command
-- and exact provider run before reserving the one target operation.

CREATE OR REPLACE FUNCTION release_workflow_reserve_exact_target_request(
  p_authorization_id text,
  p_operation_id text,
  p_command_id text,
  p_attempt_key text,
  p_attestation_id text,
  p_provider_run_id text,
  p_environment text,
  p_action text,
  p_snapshot_sha256 text,
  p_artifact_manifest_sha256 text,
  p_workflow_sha256 text,
  p_environment_generation bigint,
  p_expected_current_release_version_id text,
  p_oidc_jti_sha256 text,
  p_authorization_nonce text,
  p_target_owner_identity_sha256 text,
  p_target_owner_evidence_sha256 text,
  p_expires_at timestamptz
) RETURNS TABLE(operation_id text,owner_epoch bigint,replayed boolean,execution_snapshot jsonb) AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  reserved_operation_id text;
  reserved_owner_epoch bigint;
  reservation_replayed boolean;
BEGIN
  SELECT * INTO command_record
    FROM release_workflow_commands
   WHERE id=p_command_id
   FOR SHARE;
  IF NOT FOUND
     OR command_record.environment<>p_environment
     OR command_record.action<>p_action
     OR command_record.snapshot_sha256<>p_snapshot_sha256
     OR command_record.artifact_manifest_sha256<>p_artifact_manifest_sha256
     OR command_record.workflow_sha256<>p_workflow_sha256
     OR command_record.environment_generation<>p_environment_generation
     OR command_record.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id THEN
    RAISE EXCEPTION 'target request command binding mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE attempt_key=p_attempt_key AND fact_kind='run_bound';
  IF NOT FOUND OR run_binding.command_id<>p_command_id
     OR run_binding.provider_run_id<>p_provider_run_id
     OR run_binding.provider_run_attempt<>1
     OR run_binding.snapshot_sha256<>p_snapshot_sha256
     OR run_binding.environment_generation<>p_environment_generation THEN
    RAISE EXCEPTION 'target request run binding mismatch' USING ERRCODE='22023';
  END IF;

  SELECT reservation.operation_id,reservation.owner_epoch,reservation.replayed
    INTO reserved_operation_id,reserved_owner_epoch,reservation_replayed
    FROM release_workflow_reserve_exact_run_operation(
    p_authorization_id,p_operation_id,p_command_id,p_attempt_key,p_attestation_id,
    p_oidc_jti_sha256,p_authorization_nonce,p_target_owner_identity_sha256,
    p_target_owner_evidence_sha256,p_expires_at
  ) AS reservation;
  RETURN QUERY SELECT
    reserved_operation_id,reserved_owner_epoch,reservation_replayed,command_record.snapshot_json;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_reserve_exact_target_request(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,text,text,text,text,timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_validate_target_cutover(
  p_operation_id text,
  p_owner_epoch bigint,
  p_snapshot_sha256 text,
  p_environment_generation bigint,
  p_expected_current_release_version_id text
) RETURNS TABLE(release_version_id text,validated_at timestamptz) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  command_record release_workflow_commands%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
BEGIN
  SELECT * INTO operation
    FROM release_workflow_target_operations
   WHERE id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target operation not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO command_record
    FROM release_workflow_commands
   WHERE id=operation.command_id
   FOR SHARE;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE environment=operation.environment
   FOR UPDATE;
  IF environment_state.active_operation_id IS DISTINCT FROM operation.id
     OR environment_state.target_owner_epoch IS DISTINCT FROM p_owner_epoch
     OR environment_state.generation<>p_environment_generation
     OR environment_state.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id
     OR environment_state.stop_requested OR environment_state.blocked
     OR operation.owner_epoch>p_owner_epoch
     OR operation.snapshot_sha256<>p_snapshot_sha256
     OR operation.environment_generation<>p_environment_generation
     OR operation.expected_current_release_version_id IS DISTINCT FROM p_expected_current_release_version_id
     OR command_record.snapshot_sha256<>p_snapshot_sha256 THEN
    RAISE EXCEPTION 'target cutover fence stale' USING ERRCODE='40001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM release_workflow_receipts AS receipt
     WHERE receipt.operation_id=operation.id
       AND receipt.phase IN (
         'failed_before_cutover','uncertain_before_cutover','health_verified',
         'health_failed_after_cutover','uncertain_after_cutover','stop_committed'
       )
  ) THEN
    RAISE EXCEPTION 'target operation terminal' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT command_record.release_version_id,CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_validate_target_cutover(text,bigint,text,bigint,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_assert_migration_registry(
  p_expected_sha256 text
) RETURNS TABLE(migration_registry_sha256 text,migration_count bigint) AS $$
DECLARE
  registry_json text;
  actual_sha256 text;
  registry_count bigint;
BEGIN
  IF p_expected_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'migration registry digest invalid' USING ERRCODE='22023';
  END IF;
  SELECT
    COALESCE(string_agg(name || ':' || checksum,E'\n' ORDER BY name),''),
    count(*)
    INTO registry_json,registry_count
    FROM _agentnovas_migrations;
  IF EXISTS(
    SELECT 1 FROM _agentnovas_migrations
     WHERE checksum IS NULL OR checksum !~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'migration registry incomplete' USING ERRCODE='55000';
  END IF;
  actual_sha256 := encode(sha256(convert_to(registry_json,'UTF8')),'hex');
  IF actual_sha256<>p_expected_sha256 THEN
    RAISE EXCEPTION 'migration registry mismatch' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT actual_sha256,registry_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_assert_migration_registry(text) FROM PUBLIC;
