-- T8.2a: return one exact bound run for asynchronous authoritative provider
-- reconciliation. Webhook deliveries remain wake-up facts only and never
-- authorize or advance a command directly.

CREATE OR REPLACE FUNCTION release_workflow_claim_next_reconciliation(
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

REVOKE ALL ON FUNCTION release_workflow_claim_next_reconciliation(text,jsonb) FROM PUBLIC;
