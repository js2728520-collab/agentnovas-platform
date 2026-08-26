ALTER TABLE configuration_activations
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'user',
  ADD COLUMN actor_identity text,
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE configuration_activations
  ADD CONSTRAINT configuration_activations_actor_check CHECK (
    (actor_kind='user' AND actor_user_id IS NOT NULL AND actor_identity IS NULL)
    OR
    (actor_kind='worker' AND actor_user_id IS NULL
      AND length(actor_identity) BETWEEN 3 AND 160
      AND actor_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$')
  );

CREATE UNIQUE INDEX idx_configuration_activations_actor_idempotency
  ON configuration_activations(actor_kind,coalesce(actor_user_id,actor_identity),idempotency_key);

CREATE INDEX idx_configuration_schedules_due
  ON configuration_schedules(scheduled_for,configuration_version_id);

ALTER TABLE worker_instances
  DROP CONSTRAINT worker_instances_worker_type_check;
ALTER TABLE worker_instances
  ADD CONSTRAINT worker_instances_worker_type_check CHECK (worker_type IN (
    'research','runtime','notification','payment','demo_execution','configuration_activation'
  ));

CREATE OR REPLACE FUNCTION configuration_activation_worker_activate(
  p_version_id text
) RETURNS boolean AS $$
DECLARE
  candidate record;
  previous_version_id text;
BEGIN
  SELECT version.id,version.kind,version.configuration_key,version.audience
    INTO candidate
    FROM configuration_versions AS version
    JOIN configuration_schedules AS schedule ON schedule.configuration_version_id=version.id
    JOIN configuration_approvals AS approval ON approval.configuration_version_id=version.id
   WHERE version.id=p_version_id
     AND schedule.scheduled_for <= CURRENT_TIMESTAMP
     AND approval.decision='approve'
     AND (
       SELECT test.result
         FROM configuration_test_results AS test
        WHERE test.configuration_version_id=version.id
        ORDER BY test.sequence_no DESC
        LIMIT 1
     )='passed'
     AND NOT EXISTS (
       SELECT 1 FROM configuration_activations AS activation
        WHERE activation.configuration_version_id=version.id
     );
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'configuration-activation:' || candidate.kind || ':' || candidate.configuration_key || ':' || candidate.audience,
    0
  ));

  SELECT version.id,version.kind,version.configuration_key,version.audience
    INTO candidate
    FROM configuration_versions AS version
    JOIN configuration_schedules AS schedule ON schedule.configuration_version_id=version.id
    JOIN configuration_approvals AS approval ON approval.configuration_version_id=version.id
   WHERE version.id=p_version_id
     AND schedule.scheduled_for <= CURRENT_TIMESTAMP
     AND approval.decision='approve'
     AND (
       SELECT test.result
         FROM configuration_test_results AS test
        WHERE test.configuration_version_id=version.id
        ORDER BY test.sequence_no DESC
        LIMIT 1
     )='passed'
     AND NOT EXISTS (
       SELECT 1 FROM configuration_activations AS activation
        WHERE activation.configuration_version_id=version.id
     );
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT activation.configuration_version_id
    INTO previous_version_id
    FROM configuration_activations AS activation
    JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
   WHERE version.kind=candidate.kind
     AND version.configuration_key=candidate.configuration_key
     AND version.audience=candidate.audience
   ORDER BY activation.sequence_no DESC
   LIMIT 1;

  INSERT INTO configuration_activations(
    id,configuration_version_id,previous_configuration_version_id,action,
    actor_user_id,actor_kind,actor_identity,reason,idempotency_key,request_id
  ) VALUES(
    'configuration-worker-activation-' || md5(candidate.id),candidate.id,previous_version_id,'activate',NULL,'worker',
    'configuration-activation-worker','Scheduled configuration reached its activation time',
    'configuration-auto-activate:' || candidate.id,'configuration-activation-worker:' || candidate.id
  );
  INSERT INTO audit_logs(
    id,actor_user_id,action,subject_type,subject_id,before_json,after_json,request_id
  ) VALUES(
    'configuration-worker-audit-' || md5(candidate.id),NULL,'configuration.version.activated','configuration_version',candidate.id,
    jsonb_build_object('currentConfigurationVersionId',previous_version_id)::text,
    jsonb_build_object(
      'configurationVersionId',candidate.id,
      'action','activate',
      'actorKind','worker',
      'actorIdentity','configuration-activation-worker',
      'reason','Scheduled configuration reached its activation time'
    )::text,
    'configuration-activation-worker:' || candidate.id
  );
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION configuration_activation_worker_activate(text) FROM PUBLIC;
