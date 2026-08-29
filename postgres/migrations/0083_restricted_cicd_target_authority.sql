-- T8.2b2: the target revalidates local trust, production/rollback evidence,
-- expiry, and fresh backup evidence at the final cutover fence. Stop requests
-- are committed by the target role so stop and cutover share one target mutex.

CREATE OR REPLACE FUNCTION release_workflow_assert_target_prerequisites(
  p_command_id text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text
) RETURNS void AS $$
DECLARE
  command_record release_workflow_commands%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  staging_receipt release_workflow_receipts%ROWTYPE;
  target_history_receipt release_workflow_receipts%ROWTYPE;
  current_history_receipt release_workflow_receipts%ROWTYPE;
  current_command release_workflow_commands%ROWTYPE;
  rollback_evidence_sha256 text;
  rollback_evidence_expires_at timestamptz;
  rollback_recovery jsonb;
BEGIN
  IF p_target_binding_sha256 !~ '^[a-f0-9]{64}$'
     OR p_receipt_trust_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'target trust binding invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=p_command_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release command not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE command_id=p_command_id AND fact_kind='run_bound';
  SELECT * INTO activation FROM release_workflow_activations WHERE id=run_binding.activation_id;
  IF NOT FOUND OR activation.target_binding_sha256<>p_target_binding_sha256
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256 THEN
    RAISE EXCEPTION 'target local trust does not match activation' USING ERRCODE='42501';
  END IF;

  IF command_record.environment='production' THEN
    SELECT receipt.* INTO staging_receipt
      FROM release_workflow_receipts AS receipt
      JOIN release_workflow_target_operations AS operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands AS staging_command ON staging_command.id=operation.command_id
     WHERE staging_command.release_version_id=command_record.release_version_id
       AND staging_command.environment='staging'
       AND receipt.phase='health_verified'
       AND receipt.signature_verified
       AND receipt.payload_sha256=command_record.snapshot_json->>'stagingReceiptSha256'
       AND receipt.received_at>CURRENT_TIMESTAMP - interval '24 hours'
       AND receipt.payload_json->>'completedAt'
         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       AND CASE
         WHEN receipt.payload_json->>'completedAt'
           ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
         THEN (receipt.payload_json->>'completedAt')::timestamptz
           > CURRENT_TIMESTAMP - interval '24 hours'
           AND (receipt.payload_json->>'completedAt')::timestamptz
             <= CURRENT_TIMESTAMP + interval '30 seconds'
         ELSE false
       END
       AND staging_command.artifact_manifest_sha256=command_record.artifact_manifest_sha256
       AND staging_command.snapshot_json->>'releaseCommitSha'=command_record.snapshot_json->>'releaseCommitSha'
       AND staging_command.snapshot_json->>'releaseTag'=command_record.snapshot_json->>'releaseTag'
       AND staging_command.snapshot_json->'imageDigests'=command_record.snapshot_json->'imageDigests'
       AND staging_command.snapshot_json->>'migrationSetSha256'=command_record.snapshot_json->>'migrationSetSha256'
       AND staging_command.snapshot_json->>'migrationVersion'=command_record.snapshot_json->>'migrationVersion'
       AND receipt.payload_json->>'releaseVersionId'=command_record.release_version_id
       AND receipt.payload_json->>'artifactManifestSha256'=command_record.artifact_manifest_sha256
       AND receipt.payload_json->'imageDigests'=command_record.snapshot_json->'imageDigests'
       AND receipt.payload_json->>'migrationRegistrySha256'=command_record.snapshot_json->>'migrationSetSha256'
     ORDER BY receipt.received_at DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'same artifact staging receipt unavailable' USING ERRCODE='55000';
    END IF;
  END IF;

  IF command_record.action='rollback' THEN
    rollback_evidence_expires_at := (command_record.snapshot_json->>'rollbackEvidenceExpiresAt')::timestamptz;
    rollback_recovery:=command_record.snapshot_json->'rollbackRecoveryCapability';
    IF command_record.expected_current_release_version_id IS NULL
       OR rollback_evidence_expires_at<=CURRENT_TIMESTAMP
       OR jsonb_typeof(rollback_recovery)<>'object'
       OR rollback_recovery->>'restoreDrillResult'<>'passed'
       OR (rollback_recovery->>'targetManifestCompatible')::boolean IS DISTINCT FROM true
       OR rollback_recovery->>'targetManifestSha256' IS DISTINCT FROM command_record.artifact_manifest_sha256
       OR rollback_recovery->>'minimumMigrationVersion'>command_record.snapshot_json->>'migrationVersion'
       OR rollback_recovery->>'maximumMigrationVersion'<command_record.snapshot_json->>'migrationVersion'
       OR (rollback_recovery->>'verifiedAt')::timestamptz>CURRENT_TIMESTAMP
       OR (rollback_recovery->>'verifiedAt')::timestamptz<CURRENT_TIMESTAMP-interval '30 days'
       OR (rollback_recovery->>'retentionDeadline')::timestamptz<=rollback_evidence_expires_at THEN
      RAISE EXCEPTION 'rollback evidence, recovery capability, or current release unavailable' USING ERRCODE='55000';
    END IF;
    SELECT receipt.* INTO target_history_receipt
      FROM release_workflow_receipts AS receipt
      JOIN release_workflow_target_operations AS operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands AS history_command ON history_command.id=operation.command_id
     WHERE history_command.release_version_id=command_record.release_version_id
       AND history_command.environment=command_record.environment
       AND receipt.phase='health_verified' AND receipt.signature_verified
     ORDER BY receipt.received_at DESC LIMIT 1;
    SELECT receipt.* INTO current_history_receipt
      FROM release_workflow_receipts AS receipt
      JOIN release_workflow_target_operations AS operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands AS history_command ON history_command.id=operation.command_id
     WHERE history_command.release_version_id=command_record.expected_current_release_version_id
       AND history_command.environment=command_record.environment
       AND receipt.phase='health_verified' AND receipt.signature_verified
     ORDER BY receipt.received_at DESC LIMIT 1;
    SELECT * INTO current_command
      FROM release_workflow_commands
     WHERE id=current_history_receipt.command_id;
    IF target_history_receipt.id IS NULL OR current_history_receipt.id IS NULL
       OR target_history_receipt.received_at>=current_history_receipt.received_at
       OR target_history_receipt.payload_json->>'artifactManifestSha256'
          IS DISTINCT FROM command_record.artifact_manifest_sha256
       OR target_history_receipt.payload_json->'imageDigests'
          IS DISTINCT FROM command_record.snapshot_json->'imageDigests'
       OR target_history_receipt.payload_json->>'migrationRegistrySha256'
          IS DISTINCT FROM command_record.snapshot_json->>'migrationSetSha256'
       OR command_record.snapshot_json->>'migrationSetSha256'
          IS DISTINCT FROM current_command.snapshot_json->>'migrationSetSha256'
       OR EXISTS(
         SELECT 1
           FROM release_workflow_receipts AS receipt
           JOIN release_workflow_target_operations AS operation ON operation.id=receipt.operation_id
           JOIN release_workflow_commands AS history_command ON history_command.id=operation.command_id
          WHERE history_command.environment=command_record.environment
            AND receipt.phase='health_verified' AND receipt.signature_verified
            AND receipt.received_at>target_history_receipt.received_at
            AND receipt.received_at<=current_history_receipt.received_at
            AND COALESCE((history_command.snapshot_json->>'hasIrreversibleMigrations')::boolean,false)
       ) THEN
      RAISE EXCEPTION 'rollback history or migration compatibility invalid' USING ERRCODE='55000';
    END IF;
    rollback_evidence_sha256 := encode(sha256(convert_to(jsonb_build_object(
      'schemaVersion','1',
      'environment',command_record.environment,
      'targetReleaseVersionId',command_record.release_version_id,
      'currentReleaseVersionId',command_record.expected_current_release_version_id,
      'targetHealthReceiptSha256',target_history_receipt.payload_sha256,
      'currentHealthReceiptSha256',current_history_receipt.payload_sha256,
      'migrationSetSha256',command_record.snapshot_json->>'migrationSetSha256',
      'recoveryCapability',rollback_recovery,
      'rollbackEvidenceExpiresAt',command_record.snapshot_json->>'rollbackEvidenceExpiresAt'
    )::text,'UTF8')),'hex');
    IF command_record.snapshot_json->>'rollbackEvidenceSha256' IS DISTINCT FROM rollback_evidence_sha256 THEN
      RAISE EXCEPTION 'rollback evidence digest mismatch' USING ERRCODE='22023';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_assert_target_prerequisites(text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_reserve_exact_target_request_v2(
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
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_expires_at timestamptz
) RETURNS TABLE(operation_id text,owner_epoch bigint,replayed boolean,execution_snapshot jsonb) AS $$
DECLARE
  reservation record;
BEGIN
  SELECT * INTO reservation FROM release_workflow_reserve_exact_target_request(
    p_authorization_id,p_operation_id,p_command_id,p_attempt_key,p_attestation_id,
    p_provider_run_id,p_environment,p_action,p_snapshot_sha256,p_artifact_manifest_sha256,
    p_workflow_sha256,p_environment_generation,p_expected_current_release_version_id,
    p_oidc_jti_sha256,p_authorization_nonce,p_target_owner_identity_sha256,
    p_target_owner_evidence_sha256,p_expires_at
  );
  PERFORM release_workflow_assert_target_prerequisites(
    p_command_id,p_target_binding_sha256,p_receipt_trust_sha256
  );
  RETURN QUERY SELECT reservation.operation_id,reservation.owner_epoch,reservation.replayed,
    reservation.execution_snapshot;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_reserve_exact_target_request_v2(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_validate_target_authority_v2(
  p_operation_id text,
  p_owner_epoch bigint,
  p_snapshot_sha256 text,
  p_environment_generation bigint,
  p_expected_current_release_version_id text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(release_version_id text,validated_at timestamptz) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  authorization_record release_workflow_authorizations%ROWTYPE;
  command_record release_workflow_commands%ROWTYPE;
  approval release_workflow_approvals%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
  attestation release_workflow_run_policy_attestations%ROWTYPE;
  base_validation record;
BEGIN
  SELECT * INTO operation FROM release_workflow_target_operations WHERE id=p_operation_id;
  SELECT * INTO authorization_record FROM release_workflow_authorizations WHERE id=operation.authorization_id;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=operation.command_id FOR SHARE;
  SELECT * INTO approval FROM release_workflow_approvals WHERE command_id=operation.command_id;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE command_id=operation.command_id AND fact_kind='run_bound';
  SELECT * INTO activation FROM release_workflow_activations WHERE id=run_binding.activation_id;
  SELECT * INTO attestation FROM release_workflow_run_policy_attestations WHERE id=authorization_record.attestation_id;
  IF operation.id IS NULL OR authorization_record.id IS NULL OR command_record.id IS NULL
     OR approval.id IS NULL OR run_binding.id IS NULL OR activation.id IS NULL OR attestation.id IS NULL
     OR command_record.snapshot_json->>'expiresAt' IS NULL
     OR authorization_record.expires_at<=CURRENT_TIMESTAMP OR approval.expires_at<=CURRENT_TIMESTAMP
     OR run_binding.lease_expires_at<=CURRENT_TIMESTAMP OR activation.expires_at<=CURRENT_TIMESTAMP
     OR attestation.expires_at<=CURRENT_TIMESTAMP
     OR (command_record.snapshot_json->>'expiresAt')::timestamptz<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'target operation authority expired' USING ERRCODE='55000';
  END IF;
  PERFORM release_workflow_assert_target_prerequisites(
    operation.command_id,p_target_binding_sha256,p_receipt_trust_sha256
  );
  SELECT * INTO base_validation FROM release_workflow_validate_target_cutover(
    p_operation_id,p_owner_epoch,p_snapshot_sha256,p_environment_generation,
    p_expected_current_release_version_id
  );
  RETURN QUERY SELECT base_validation.release_version_id,base_validation.validated_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_validate_target_authority_v2(
  text,bigint,text,bigint,text,text,text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_recover_target_operation_v2(
  p_operation_id text,
  p_owner_identity_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(owner_epoch bigint,execution_snapshot jsonb,run_id text,oidc_jti_sha256 text,authorization_nonce text) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  owner_record release_workflow_target_owner_epochs%ROWTYPE;
  command_record release_workflow_commands%ROWTYPE;
  authorization_record release_workflow_authorizations%ROWTYPE;
  run_binding release_workflow_attempts%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
BEGIN
  SELECT * INTO operation FROM release_workflow_target_operations WHERE id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target operation not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO environment_state FROM release_workflow_environment_states
   WHERE environment=operation.environment FOR SHARE;
  SELECT * INTO owner_record FROM release_workflow_target_owner_epochs
   WHERE operation_id=operation.id AND owner_epoch=environment_state.target_owner_epoch;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=operation.command_id FOR SHARE;
  SELECT * INTO authorization_record FROM release_workflow_authorizations WHERE id=operation.authorization_id;
  SELECT * INTO run_binding
    FROM release_workflow_attempts
   WHERE command_id=operation.command_id AND fact_kind='run_bound';
  SELECT * INTO activation FROM release_workflow_activations WHERE id=run_binding.activation_id;
  IF environment_state.active_operation_id IS DISTINCT FROM operation.id
     OR owner_record.owner_identity_sha256<>p_owner_identity_sha256
     OR activation.id IS NULL
     OR activation.target_binding_sha256<>p_target_binding_sha256
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256
     OR EXISTS(
       SELECT 1 FROM release_workflow_receipts
        WHERE operation_id=operation.id
          AND phase IN ('failed_before_cutover','uncertain_before_cutover','health_verified',
            'health_failed_after_cutover','uncertain_after_cutover','stop_committed')
     ) THEN
    RAISE EXCEPTION 'target operation is not recoverable' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT owner_record.owner_epoch,command_record.snapshot_json,
    authorization_record.run_id,authorization_record.oidc_jti_sha256,authorization_record.authorization_nonce;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_recover_target_operation_v2(text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_list_recoverable_target_operations_v2(
  p_environment text,
  p_owner_identity_sha256 text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(operation_id text,command_id text) AS $$
BEGIN
  IF p_environment NOT IN ('staging','production')
     OR p_owner_identity_sha256 !~ '^[a-f0-9]{64}$'
     OR p_target_binding_sha256 !~ '^[a-f0-9]{64}$'
     OR p_receipt_trust_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'target recovery query invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT operation.id,operation.command_id
      FROM release_workflow_target_operations AS operation
      JOIN release_workflow_environment_states AS environment_state
        ON environment_state.environment=operation.environment
       AND environment_state.active_operation_id=operation.id
      JOIN release_workflow_target_owner_epochs AS owner
        ON owner.operation_id=operation.id
       AND owner.owner_epoch=environment_state.target_owner_epoch
      JOIN release_workflow_attempts AS run_binding
        ON run_binding.command_id=operation.command_id AND run_binding.fact_kind='run_bound'
      JOIN release_workflow_activations AS activation ON activation.id=run_binding.activation_id
     WHERE operation.environment=p_environment
       AND owner.owner_identity_sha256=p_owner_identity_sha256
       AND activation.target_binding_sha256=p_target_binding_sha256
       AND activation.receipt_trust_sha256=p_receipt_trust_sha256
       AND NOT EXISTS(
         SELECT 1 FROM release_workflow_receipts AS receipt
          WHERE receipt.operation_id=operation.id
            AND receipt.phase IN ('failed_before_cutover','uncertain_before_cutover','health_verified',
              'health_failed_after_cutover','uncertain_after_cutover','stop_committed')
       )
     ORDER BY operation.created_at,operation.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_list_recoverable_target_operations_v2(text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_validate_target_cutover_v2(
  p_operation_id text,
  p_owner_epoch bigint,
  p_snapshot_sha256 text,
  p_environment_generation bigint,
  p_expected_current_release_version_id text,
  p_target_binding_sha256 text,
  p_receipt_trust_sha256 text,
  p_backup_id text,
  p_backup_sha256 text,
  p_restore_toc_sha256 text,
  p_restore_plan_sha256 text,
  p_backup_created_at timestamptz
) RETURNS TABLE(release_version_id text,validated_at timestamptz) AS $$
DECLARE
  operation release_workflow_target_operations%ROWTYPE;
  command_record release_workflow_commands%ROWTYPE;
  base_validation record;
  expected_restore_plan_sha256 text;
  rollback_recovery jsonb;
  expected_rollback_evidence_sha256 text;
BEGIN
  IF p_backup_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'
     OR p_backup_sha256 !~ '^[a-f0-9]{64}$' OR p_restore_toc_sha256 !~ '^[a-f0-9]{64}$'
     OR p_restore_plan_sha256 !~ '^[a-f0-9]{64}$'
     OR p_backup_created_at>CURRENT_TIMESTAMP + interval '30 seconds'
     OR p_backup_created_at<CURRENT_TIMESTAMP - interval '15 minutes' THEN
    RAISE EXCEPTION 'fresh validated backup evidence required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO operation FROM release_workflow_target_operations WHERE id=p_operation_id;
  SELECT * INTO command_record FROM release_workflow_commands WHERE id=operation.command_id FOR SHARE;
  IF p_backup_created_at<operation.created_at THEN
    RAISE EXCEPTION 'backup predates target operation' USING ERRCODE='55000';
  END IF;
  expected_restore_plan_sha256 := encode(sha256(convert_to(concat_ws(chr(31),
    'restricted-cicd-restore-plan-v1',operation.id,command_record.release_version_id,
    COALESCE(command_record.expected_current_release_version_id,''),
    command_record.environment_generation::text,
    command_record.snapshot_json->>'migrationSetSha256',
    command_record.snapshot_json->>'migrationVersion',p_backup_id,p_backup_sha256,
    p_restore_toc_sha256,'pg_restore-list-v1'
  ),'UTF8')),'hex');
  IF p_restore_plan_sha256<>expected_restore_plan_sha256 THEN
    RAISE EXCEPTION 'restore plan evidence mismatch' USING ERRCODE='22023';
  END IF;
  IF command_record.action='rollback' THEN
    rollback_recovery:=command_record.snapshot_json->'rollbackRecoveryCapability';
    IF jsonb_typeof(rollback_recovery)<>'object'
       OR rollback_recovery->>'rehearsalBackupId' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'
       OR rollback_recovery->>'rehearsalBackupSha256' !~ '^[a-f0-9]{64}$'
       OR rollback_recovery->>'restoreTocSha256' !~ '^[a-f0-9]{64}$'
       OR rollback_recovery->>'restorePlanSha256' !~ '^[a-f0-9]{64}$'
       OR rollback_recovery->>'restoreDrillResult'<>'passed'
       OR (rollback_recovery->>'targetManifestCompatible')::boolean IS DISTINCT FROM true
       OR rollback_recovery->>'targetManifestSha256' IS DISTINCT FROM command_record.artifact_manifest_sha256
       OR rollback_recovery->>'minimumMigrationVersion'>command_record.snapshot_json->>'migrationVersion'
       OR rollback_recovery->>'maximumMigrationVersion'<command_record.snapshot_json->>'migrationVersion'
       OR (rollback_recovery->>'verifiedAt')::timestamptz>CURRENT_TIMESTAMP
       OR (rollback_recovery->>'verifiedAt')::timestamptz<CURRENT_TIMESTAMP-interval '30 days'
       OR (rollback_recovery->>'retentionDeadline')::timestamptz<=CURRENT_TIMESTAMP
       OR (command_record.snapshot_json->>'rollbackEvidenceExpiresAt')::timestamptz<=CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'rollback recovery capability unavailable' USING ERRCODE='55000';
    END IF;
    expected_rollback_evidence_sha256:=encode(sha256(convert_to(jsonb_build_object(
      'schemaVersion','1','environment',command_record.environment,
      'targetReleaseVersionId',command_record.release_version_id,
      'currentReleaseVersionId',command_record.expected_current_release_version_id,
      'targetHealthReceiptSha256',command_record.snapshot_json->>'targetHealthReceiptSha256',
      'currentHealthReceiptSha256',command_record.snapshot_json->>'currentHealthReceiptSha256',
      'migrationSetSha256',command_record.snapshot_json->>'migrationSetSha256',
      'recoveryCapability',rollback_recovery,
      'rollbackEvidenceExpiresAt',command_record.snapshot_json->>'rollbackEvidenceExpiresAt'
    )::text,'UTF8')),'hex');
    IF expected_rollback_evidence_sha256 IS DISTINCT FROM command_record.snapshot_json->>'rollbackEvidenceSha256' THEN
      RAISE EXCEPTION 'rollback recovery evidence mismatch' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT * INTO base_validation FROM release_workflow_validate_target_authority_v2(
    p_operation_id,p_owner_epoch,p_snapshot_sha256,p_environment_generation,
    p_expected_current_release_version_id,p_target_binding_sha256,p_receipt_trust_sha256
  );
  RETURN QUERY SELECT base_validation.release_version_id,base_validation.validated_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_validate_target_cutover_v2(
  text,bigint,text,bigint,text,text,text,text,text,text,text,timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_target_request_stop(
  p_id text,
  p_environment text,
  p_actor_kind text,
  p_actor_identity text,
  p_reason text
) RETURNS TABLE(
  generation bigint,
  expected_current_release_version_id text,
  requested_at timestamptz,
  replayed boolean
) AS $$
DECLARE
  environment_state release_workflow_environment_states%ROWTYPE;
  existing release_workflow_stops%ROWTYPE;
  next_generation bigint;
  inserted_at timestamptz;
BEGIN
  IF p_actor_kind NOT IN ('user','break_glass')
     OR (p_actor_kind='user' AND NOT EXISTS(
       SELECT 1 FROM users WHERE id=p_actor_identity AND status='active'
     )) THEN
    RAISE EXCEPTION 'stop actor unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO environment_state
    FROM release_workflow_environment_states
   WHERE environment=p_environment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release environment not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO existing FROM release_workflow_stops WHERE id=p_id;
  IF FOUND THEN
    IF existing.environment<>p_environment OR existing.action<>'requested'
       OR existing.actor_kind<>p_actor_kind OR existing.actor_identity<>p_actor_identity
       OR existing.reason<>p_reason THEN
      RAISE EXCEPTION 'target stop replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.generation,environment_state.expected_current_release_version_id,
      existing.created_at,true;
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
    environment_state.expected_current_release_version_id,p_reason,p_actor_kind,p_actor_identity
  );
  INSERT INTO release_workflow_stops(id,environment,action,generation,actor_kind,actor_identity,reason)
  VALUES(p_id,p_environment,'requested',next_generation,p_actor_kind,p_actor_identity,p_reason)
  RETURNING created_at INTO inserted_at;
  UPDATE release_workflow_environment_states
     SET generation=next_generation,stop_requested=true,updated_at=CURRENT_TIMESTAMP
   WHERE environment=p_environment;
  RETURN QUERY SELECT next_generation,environment_state.expected_current_release_version_id,
    inserted_at,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_target_request_stop(text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_prepare_target_clear_ack_v2(
  p_stop_id text,
  p_environment text,
  p_generation bigint,
  p_activation_id text,
  p_expected_current_release_version_id text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(stop_requested_at timestamptz) AS $$
DECLARE
  stop_request release_workflow_stops%ROWTYPE;
  environment_state release_workflow_environment_states%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
BEGIN
  SELECT * INTO environment_state FROM release_workflow_environment_states
   WHERE environment=p_environment FOR SHARE;
  SELECT * INTO stop_request FROM release_workflow_stops
   WHERE id=p_stop_id AND action='requested';
  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  IF environment_state.environment IS NULL OR stop_request.id IS NULL OR activation.id IS NULL
     OR stop_request.environment<>p_environment OR stop_request.generation<>p_generation
     OR environment_state.generation<>p_generation OR NOT environment_state.stop_requested
     OR environment_state.expected_current_release_version_id
        IS DISTINCT FROM p_expected_current_release_version_id
     OR activation.environment<>p_environment OR activation.created_at<=stop_request.created_at
     OR activation.expires_at<=CURRENT_TIMESTAMP
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256 THEN
    RAISE EXCEPTION 'target clear acknowledgement authority unavailable' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT stop_request.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_prepare_target_clear_ack_v2(text,text,bigint,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_validate_target_stop_cleared_v2(
  p_stop_id text,
  p_environment text,
  p_stopped_generation bigint,
  p_activation_id text,
  p_receipt_trust_sha256 text
) RETURNS TABLE(cleared_generation bigint,expected_current_release_version_id text,cleared_at timestamptz) AS $$
DECLARE
  environment_state release_workflow_environment_states%ROWTYPE;
  stop_request release_workflow_stops%ROWTYPE;
  clear_fact release_workflow_stops%ROWTYPE;
  activation release_workflow_activations%ROWTYPE;
BEGIN
  SELECT * INTO environment_state FROM release_workflow_environment_states
   WHERE environment=p_environment FOR SHARE;
  SELECT * INTO stop_request FROM release_workflow_stops WHERE id=p_stop_id AND action='requested';
  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  SELECT * INTO clear_fact FROM release_workflow_stops
   WHERE environment=p_environment AND action='cleared' AND activation_id=p_activation_id
     AND generation=p_stopped_generation+1
   ORDER BY created_at DESC LIMIT 1;
  IF environment_state.environment IS NULL OR stop_request.id IS NULL OR activation.id IS NULL
     OR clear_fact.id IS NULL OR stop_request.generation<>p_stopped_generation
     OR environment_state.stop_requested OR environment_state.generation<>p_stopped_generation+1
     OR activation.environment<>p_environment
     OR activation.receipt_trust_sha256<>p_receipt_trust_sha256
     OR clear_fact.created_at<=stop_request.created_at THEN
    RAISE EXCEPTION 'target stop clear has not committed' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT environment_state.generation,
    environment_state.expected_current_release_version_id,clear_fact.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_validate_target_stop_cleared_v2(text,text,bigint,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_workflow_append_stop_receipt_v2(
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
  p_receipt_trust_sha256 text,
  p_signature_verified boolean
) RETURNS TABLE(stop_receipt_id text,replayed boolean) AS $$
DECLARE
  stop_request release_workflow_stops%ROWTYPE;
  trusted_activation release_workflow_activations%ROWTYPE;
  appended record;
BEGIN
  SELECT * INTO stop_request FROM release_workflow_stops WHERE id=p_stop_id AND action='requested';
  IF p_phase='clear_acknowledged' THEN
    SELECT * INTO trusted_activation FROM release_workflow_activations WHERE id=p_activation_id;
  ELSE
    SELECT * INTO trusted_activation FROM release_workflow_activations
     WHERE environment=p_environment ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF stop_request.id IS NULL OR trusted_activation.id IS NULL
     OR trusted_activation.environment<>p_environment
     OR trusted_activation.receipt_trust_sha256<>p_receipt_trust_sha256
     OR (p_phase='stop_committed' AND p_activation_id IS NOT NULL)
     OR (p_phase='clear_acknowledged' AND (
       p_activation_id IS NULL OR p_actor_kind<>'target'
       OR trusted_activation.created_at<=stop_request.created_at
       OR trusted_activation.expires_at<=CURRENT_TIMESTAMP
     ))
     OR (p_phase='stop_committed' AND stop_request.actor_kind='break_glass' AND p_actor_kind<>'break_glass')
     OR (p_phase='stop_committed' AND stop_request.actor_kind='user' AND p_actor_kind<>'target') THEN
    RAISE EXCEPTION 'stop receipt authority mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO appended FROM release_workflow_append_stop_receipt(
    p_id,p_stop_id,p_environment,p_generation,p_phase,p_activation_id,
    p_expected_current_release_version_id,p_receipt_nonce,p_key_id,p_payload_json,
    p_payload_sha256,p_signature,p_actor_kind,p_actor_fingerprint_sha256,p_signature_verified
  );
  RETURN QUERY SELECT appended.stop_receipt_id,appended.replayed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION release_workflow_append_stop_receipt_v2(
  text,text,text,bigint,text,text,text,text,text,jsonb,text,text,text,text,text,boolean
) FROM PUBLIC;

-- Upgrades must remove the former direct-stop and v1 target paths immediately;
-- the deployment role template repeats this convergence after all migrations.
DO $target_authority_acl_convergence$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    REVOKE EXECUTE ON FUNCTION release_workflow_request_stop(text,text,text,text)
      FROM agentnovas_maint_web;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_release_target_gateway') THEN
    REVOKE EXECUTE ON FUNCTION release_workflow_reserve_exact_target_request(
      text,text,text,text,text,text,text,text,text,text,text,bigint,text,text,text,text,text,timestamptz
    ) FROM agentnovas_release_target_gateway;
    REVOKE EXECUTE ON FUNCTION release_workflow_validate_target_cutover(text,bigint,text,bigint,text)
      FROM agentnovas_release_target_gateway;
    REVOKE EXECUTE ON FUNCTION release_workflow_append_stop_receipt(
      text,text,text,bigint,text,text,text,text,text,jsonb,text,text,text,text,boolean
    ) FROM agentnovas_release_target_gateway;
  END IF;
END
$target_authority_acl_convergence$;
