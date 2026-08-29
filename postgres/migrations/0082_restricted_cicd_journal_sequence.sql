-- Preserve the target journal's real checkpoint sequence in receipts. Internal
-- checkpoints (prepared/applying/cutover intent) are not published as receipts,
-- so receipt sequences must be strictly increasing rather than artificially
-- rewritten as 1,2.

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
  SELECT * INTO previous_receipt
    FROM release_workflow_receipts
   WHERE operation_id=p_operation_id
   ORDER BY journal_sequence DESC
   LIMIT 1;
  IF p_journal_sequence<1
     OR (previous_receipt.id IS NOT NULL AND p_journal_sequence<=previous_receipt.journal_sequence) THEN
    RAISE EXCEPTION 'journal sequence invalid' USING ERRCODE='22023';
  END IF;
  IF previous_receipt.id IS NULL THEN
    IF p_phase NOT IN (
      'failed_before_cutover','uncertain_before_cutover','cutover_committed','uncertain_after_cutover','stop_committed'
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
     OR COALESCE(p_payload_json->>'journalPhase',p_payload_json->>'phase') IS DISTINCT FROM p_phase
     OR p_payload_json->>'ownerEpoch' IS DISTINCT FROM p_owner_epoch::text
     OR p_payload_json->>'journalSequence' IS DISTINCT FROM p_journal_sequence::text
     OR p_payload_json->>'actualPreviousReleaseVersionId' IS DISTINCT FROM p_actual_previous_release_version_id
     OR p_payload_json->>'actualCurrentReleaseVersionId' IS DISTINCT FROM p_actual_current_release_version_id THEN
    RAISE EXCEPTION 'receipt payload binding mismatch' USING ERRCODE='22023';
  END IF;
  IF p_phase IN ('cutover_committed','health_verified','health_failed_after_cutover') THEN
    IF p_actual_previous_release_version_id IS DISTINCT FROM operation.expected_current_release_version_id
       OR p_actual_current_release_version_id IS DISTINCT FROM command_record.release_version_id THEN
      RAISE EXCEPTION 'receipt current binding mismatch' USING ERRCODE='22023';
    END IF;
  ELSIF p_phase='uncertain_after_cutover' THEN
    IF p_actual_previous_release_version_id IS DISTINCT FROM operation.expected_current_release_version_id
       OR (p_actual_current_release_version_id IS NOT NULL
         AND p_actual_current_release_version_id IS DISTINCT FROM command_record.release_version_id) THEN
      RAISE EXCEPTION 'uncertain receipt current binding mismatch' USING ERRCODE='22023';
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

REVOKE ALL ON FUNCTION release_workflow_append_target_receipt(
  text,text,text,text,jsonb,text,text,text,bigint,bigint,text,text,boolean
) FROM PUBLIC;
