-- T8.2c exposes a Maintenance control plane without giving the browser a way
-- to invent a second actor or write terminal activation/stop-clear facts.

INSERT INTO permission_definitions(key,application_id,label,description,sensitive,status)
VALUES
  ('maint.releases.workflow.view','maintenance','查看受限发布工作流','查看脱敏命令、activation 与 stop 状态',false,'active'),
  ('maint.releases.workflow.stage','maintenance','请求 staging 发布','为已验证版本请求 staging deploy 或 rollback',true,'active'),
  ('maint.releases.workflow.production.request','maintenance','请求 production 发布','创建 production deploy 或 rollback 请求',true,'active'),
  ('maint.releases.workflow.production.approve','maintenance','审批 production 发布','独立审批 production deploy 或 rollback',true,'active'),
  ('maint.releases.workflow.activation.request','maintenance','请求发布 activation','创建 staging 或 production activation 请求',true,'active'),
  ('maint.releases.workflow.activation.approve','maintenance','审批发布 activation','作为独立 security 或 release checker 审批 activation',true,'active'),
  ('maint.releases.workflow.production.enable','maintenance','首次启用 production','明确创建不可变的首次 production enablement',true,'active'),
  ('maint.releases.workflow.stop','maintenance','停止受限发布工作流','立即请求 sticky stop',true,'active'),
  ('maint.releases.workflow.stop.release','maintenance','批准解除发布 stop','以不同人员批准解除 sticky stop',true,'active')
ON CONFLICT(key) DO UPDATE SET
  application_id=EXCLUDED.application_id,label=EXCLUDED.label,description=EXCLUDED.description,
  sensitive=EXCLUDED.sensitive,status=EXCLUDED.status,updated_at=now();

-- These two facts are populated only by the migrator-controlled release/G7
-- evidence path.  Web roles never receive table privileges, so a browser
-- request can select a release but cannot invent deployable material or trust.
CREATE TABLE release_workflow_artifact_manifests (
  release_version_id text PRIMARY KEY REFERENCES release_versions(id) ON DELETE RESTRICT,
  artifact_manifest_sha256 text NOT NULL UNIQUE CHECK (artifact_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  client_image_sha256 text NOT NULL CHECK (client_image_sha256 ~ '^[a-f0-9]{64}$'),
  operations_image_sha256 text NOT NULL CHECK (operations_image_sha256 ~ '^[a-f0-9]{64}$'),
  maintenance_image_sha256 text NOT NULL CHECK (maintenance_image_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_image_sha256 text NOT NULL CHECK (runtime_image_sha256 ~ '^[a-f0-9]{64}$'),
  migration_set_sha256 text NOT NULL CHECK (migration_set_sha256 ~ '^[a-f0-9]{64}$'),
  migration_version text NOT NULL CHECK (migration_version ~ '^[0-9]{4}_[a-z0-9_]{3,96}$'),
  has_irreversible_migrations boolean NOT NULL,
  provenance_evidence_sha256 text NOT NULL CHECK (provenance_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  material_sha256 text NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_control_bundles (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  artifact_manifest_sha256 text NOT NULL REFERENCES release_workflow_artifact_manifests(artifact_manifest_sha256) ON DELETE RESTRICT,
  g7_manifest_sha256 text NOT NULL CHECK (g7_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  provider_binding_sha256 text NOT NULL REFERENCES release_workflow_provider_bindings(provider_binding_sha256) ON DELETE RESTRICT,
  workflow_sha256 text NOT NULL CHECK (workflow_sha256 ~ '^[a-f0-9]{64}$'),
  environment_policy_sha256 text NOT NULL CHECK (environment_policy_sha256 ~ '^[a-f0-9]{64}$'),
  runner_policy_sha256 text NOT NULL CHECK (runner_policy_sha256 ~ '^[a-f0-9]{64}$'),
  target_binding_sha256 text NOT NULL CHECK (target_binding_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_trust_sha256 text NOT NULL CHECK (receipt_trust_sha256 ~ '^[a-f0-9]{64}$'),
  auditor_trust_sha256 text NOT NULL CHECK (auditor_trust_sha256 ~ '^[a-f0-9]{64}$'),
  reviewer_allowlist_sha256 text NOT NULL CHECK (reviewer_allowlist_sha256 ~ '^[a-f0-9]{64}$'),
  provenance_evidence_sha256 text NOT NULL CHECK (provenance_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at>registered_at),
  UNIQUE(environment,artifact_manifest_sha256,g7_manifest_sha256)
);

-- Human reviewer identity and recovery capability are also registrar-owned
-- facts. Generic Maintenance RBAC/session writers cannot create either fact.
CREATE TABLE release_workflow_actor_authorities (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','service')),
  identity_evidence_sha256 text NOT NULL CHECK (identity_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_restore_capabilities (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  current_release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  target_release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  rehearsal_backup_id text NOT NULL CHECK (rehearsal_backup_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  rehearsal_backup_sha256 text NOT NULL CHECK (rehearsal_backup_sha256 ~ '^[a-f0-9]{64}$'),
  restore_toc_sha256 text NOT NULL CHECK (restore_toc_sha256 ~ '^[a-f0-9]{64}$'),
  restore_plan_sha256 text NOT NULL CHECK (restore_plan_sha256 ~ '^[a-f0-9]{64}$'),
  restore_drill_version text NOT NULL CHECK (length(restore_drill_version) BETWEEN 3 AND 160),
  restore_drill_result text NOT NULL CHECK (restore_drill_result IN ('passed','failed')),
  verified_at timestamptz NOT NULL,
  retention_deadline timestamptz NOT NULL,
  minimum_migration_version text NOT NULL CHECK (minimum_migration_version ~ '^[0-9]{4}_[a-z0-9_]{3,96}$'),
  maximum_migration_version text NOT NULL CHECK (maximum_migration_version ~ '^[0-9]{4}_[a-z0-9_]{3,96}$'),
  target_manifest_sha256 text NOT NULL CHECK (target_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  target_manifest_compatible boolean NOT NULL,
  compatibility_evidence_sha256 text NOT NULL CHECK (compatibility_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (current_release_version_id<>target_release_version_id),
  CHECK (retention_deadline>verified_at),
  CHECK (minimum_migration_version<=maximum_migration_version),
  UNIQUE(environment,current_release_version_id,target_release_version_id,restore_drill_version)
);

CREATE TABLE release_workflow_human_action_authorities (
  authority_id text PRIMARY KEY CHECK (authority_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_secret_sha256 text NOT NULL CHECK (session_secret_sha256 ~ '^[a-f0-9]{64}$'),
  recent_mfa_evidence_sha256 text NOT NULL CHECK (recent_mfa_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  permission_key text NOT NULL REFERENCES permission_definitions(key) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN (
    'activation.request','activation.review','production.enable','command.request','command.review',
    'stop.request','stop_release.request','stop_release.review'
  )),
  mutation_sha256 text NOT NULL CHECK (mutation_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes')
);
CREATE INDEX release_workflow_human_action_authority_lookup
  ON release_workflow_human_action_authorities(actor_user_id,idempotency_key,mutation_sha256,issued_at DESC);

CREATE TABLE release_workflow_human_action_assertions (
  challenge_id text PRIMARY KEY CHECK (challenge_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  authority_id text NOT NULL UNIQUE REFERENCES release_workflow_human_action_authorities(authority_id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  permission_key text NOT NULL REFERENCES permission_definitions(key) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN (
    'activation.request','activation.review','production.enable','command.request','command.review',
    'stop.request','stop_release.request','stop_release.review'
  )),
  mutation_sha256 text NOT NULL CHECK (mutation_sha256 ~ '^[a-f0-9]{64}$'),
  assertion_sha256 text NOT NULL UNIQUE CHECK (assertion_sha256 ~ '^[a-f0-9]{64}$'),
  credential_id_sha256 text NOT NULL CHECK (credential_id_sha256 ~ '^[a-f0-9]{64}$'),
  origin_sha256 text NOT NULL CHECK (origin_sha256 ~ '^[a-f0-9]{64}$'),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  credential_id text NOT NULL CHECK (length(credential_id) BETWEEN 16 AND 2048),
  client_data_json text NOT NULL CHECK (length(client_data_json) BETWEEN 16 AND 8192),
  authenticator_data text NOT NULL CHECK (length(authenticator_data) BETWEEN 16 AND 8192),
  signature text NOT NULL CHECK (length(signature) BETWEEN 16 AND 8192),
  sign_count bigint NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at>verified_at),
  CHECK (verified_at<=registered_at+interval '30 seconds'),
  CHECK (expires_at<=registered_at+interval '5 minutes')
);

CREATE TABLE release_workflow_human_action_assertion_consumptions (
  assertion_id text PRIMARY KEY REFERENCES release_workflow_human_action_assertions(challenge_id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN (
    'activation.request','activation.review','production.enable','command.request','command.review',
    'stop.request','stop_release.request','stop_release.review'
  )),
  mutation_sha256 text NOT NULL CHECK (mutation_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object' AND octet_length(result_json::text)<=8192),
  consumed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE release_workflow_command_requests (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  action text NOT NULL CHECK (action IN ('deploy','rollback')),
  activation_id text NOT NULL REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  material_json jsonb NOT NULL CHECK (jsonb_typeof(material_json)='object' AND octet_length(material_json::text)<=8192),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requested_by_user_id,idempotency_key)
);

CREATE TABLE release_workflow_command_request_reviews (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  command_request_id text NOT NULL UNIQUE REFERENCES release_workflow_command_requests(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  expires_at timestamptz NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at>created_at)
);

CREATE TABLE release_workflow_activation_requests (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  control_bundle_id text NOT NULL REFERENCES release_workflow_control_bundles(id) ON DELETE RESTRICT,
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
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requested_by_user_id,idempotency_key),
  CHECK (expires_at>created_at)
);

CREATE TABLE release_workflow_activation_request_reviews (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  activation_request_id text NOT NULL REFERENCES release_workflow_activation_requests(id) ON DELETE RESTRICT,
  approval_kind text NOT NULL CHECK (approval_kind IN ('security','release')),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(activation_request_id,approval_kind)
);

CREATE TABLE release_workflow_stop_release_requests (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  activation_id text NOT NULL REFERENCES release_workflow_activations(id) ON DELETE RESTRICT,
  requested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requested_by_user_id,idempotency_key)
);

CREATE TABLE release_workflow_stop_release_reviews (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$'),
  stop_release_request_id text NOT NULL UNIQUE REFERENCES release_workflow_stop_release_requests(id) ON DELETE RESTRICT,
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $maintenance_control_tables$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'release_workflow_artifact_manifests','release_workflow_control_bundles',
    'release_workflow_actor_authorities','release_workflow_restore_capabilities',
    'release_workflow_human_action_authorities','release_workflow_human_action_assertions',
    'release_workflow_human_action_assertion_consumptions',
    'release_workflow_command_requests','release_workflow_command_request_reviews',
    'release_workflow_activation_requests','release_workflow_activation_request_reviews',
    'release_workflow_stop_release_requests','release_workflow_stop_release_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_release_workflow_fact_immutable()',
      'trg_' || table_name || '_immutable',table_name
    );
  END LOOP;
END
$maintenance_control_tables$;

CREATE OR REPLACE FUNCTION release_workflow_require_maintenance_actor(
  p_session_secret text,p_permission_key text
) RETURNS TABLE(actor_user_id text,recent_mfa_evidence_sha256 text) AS $$
BEGIN
  IF length(p_session_secret) NOT BETWEEN 32 AND 512 THEN
    RAISE EXCEPTION 'maintenance session assertion invalid' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT session.user_id,
         encode(sha256(convert_to(
           session.id||':'||session.user_id||':'||to_char(session.mfa_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'UTF8'
         )),'hex')
    FROM sessions AS session
    JOIN users AS actor ON actor.id=session.user_id
    JOIN user_role_assignments assignment ON assignment.user_id=actor.id
    JOIN roles role ON role.id=assignment.role_id
    JOIN role_permissions permission ON permission.role_id=role.id
    JOIN permission_definitions definition ON definition.key=permission.permission_key
    JOIN release_workflow_actor_authorities authority
      ON authority.user_id=actor.id AND authority.actor_kind='human'
   WHERE session.token_hash=encode(sha256(convert_to(p_session_secret,'UTF8')),'hex')
     AND session.app_audience='maintenance'
     AND session.revoked_at IS NULL
     AND session.expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.idle_expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.absolute_expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.mfa_level IN ('totp','recovery')
     AND session.mfa_verified_at>CURRENT_TIMESTAMP-interval '15 minutes'
     AND actor.status='active'
     AND assignment.application_id='maintenance'
     AND assignment.status='active'
     AND assignment.effective_at<=CURRENT_TIMESTAMP
     AND (assignment.expires_at IS NULL OR assignment.expires_at>CURRENT_TIMESTAMP)
     AND role.application_id='maintenance' AND role.status='published'
     AND definition.application_id='maintenance' AND definition.status='active'
     AND permission.permission_key=p_permission_key AND permission.scope='PLATFORM'
   ORDER BY assignment.id
   LIMIT 1
   FOR SHARE OF session,actor,assignment,role,permission,definition,authority;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'maintenance actor permission or recent MFA unavailable' USING ERRCODE='42501';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_issue_human_action_authority(
  p_actor_user_id text,p_session_secret text,p_permission_key text,p_operation text,
  p_mutation_sha256 text,p_idempotency_key text,p_request_id text
) RETURNS TABLE(authority_id text,replayed boolean) AS $$
DECLARE actor_id text;
DECLARE mfa_evidence_sha256 text;
DECLARE generated_id text;
DECLARE existing release_workflow_human_action_authorities%ROWTYPE;
BEGIN
  SELECT authority.actor_user_id,authority.recent_mfa_evidence_sha256 INTO actor_id,mfa_evidence_sha256
    FROM release_workflow_require_maintenance_actor(p_session_secret,p_permission_key) authority;
  IF actor_id<>p_actor_user_id OR p_operation NOT IN (
       'activation.request','activation.review','production.enable','command.request','command.review',
       'stop.request','stop_release.request','stop_release.review'
     ) OR p_mutation_sha256 !~ '^[a-f0-9]{64}$'
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 160 OR length(p_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'human action authority invalid' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'release-human-authority:'||actor_id||':'||p_idempotency_key||':'||p_mutation_sha256||':'||p_request_id,0
  ));
  SELECT * INTO existing FROM release_workflow_human_action_authorities
   WHERE actor_user_id=actor_id AND idempotency_key=p_idempotency_key
     AND mutation_sha256=p_mutation_sha256 AND request_id=p_request_id
   ORDER BY issued_at DESC,authority_id DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF existing.session_secret_sha256<>encode(sha256(convert_to(p_session_secret,'UTF8')),'hex')
       OR existing.permission_key<>p_permission_key OR existing.operation<>p_operation THEN
      RAISE EXCEPTION 'human action authority replay mismatch' USING ERRCODE='23505';
    END IF;
    IF existing.recent_mfa_evidence_sha256=mfa_evidence_sha256 AND (
         NOT EXISTS(SELECT 1 FROM release_workflow_human_action_assertions item WHERE item.authority_id=existing.authority_id)
           AND existing.expires_at>CURRENT_TIMESTAMP
         OR EXISTS(
           SELECT 1 FROM release_workflow_human_action_assertions item
            WHERE item.authority_id=existing.authority_id AND (
              item.expires_at>CURRENT_TIMESTAMP OR EXISTS(
                SELECT 1 FROM release_workflow_human_action_assertion_consumptions consumed
                 WHERE consumed.assertion_id=item.challenge_id
              )
            )
         )
       ) THEN
      RETURN QUERY SELECT existing.authority_id,true; RETURN;
    END IF;
  END IF;
  generated_id:='release-authority-'||replace(gen_random_uuid()::text,'-','')
    ||substr(encode(sha256(convert_to(actor_id||':'||p_mutation_sha256||':'||clock_timestamp()::text,'UTF8')),'hex'),1,16);
  INSERT INTO release_workflow_human_action_authorities(
    authority_id,actor_user_id,session_secret_sha256,recent_mfa_evidence_sha256,permission_key,operation,
    mutation_sha256,idempotency_key,request_id,expires_at
  ) VALUES(
    generated_id,actor_id,encode(sha256(convert_to(p_session_secret,'UTF8')),'hex'),mfa_evidence_sha256,p_permission_key,p_operation,
    p_mutation_sha256,p_idempotency_key,p_request_id,CURRENT_TIMESTAMP+interval '3 minutes'
  );
  RETURN QUERY SELECT generated_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_record_human_action_assertion(
  p_challenge_id text,p_authority_id text,p_actor_user_id text,p_permission_key text,p_operation text,
  p_mutation_sha256 text,p_assertion_sha256 text,p_credential_id_sha256 text,p_origin_sha256 text,
  p_sign_count bigint,p_idempotency_key text,p_request_id text,p_verified_at timestamptz,p_expires_at timestamptz,
  p_policy_sha256 text,p_credential_id text,p_client_data_json text,p_authenticator_data text,p_signature text
) RETURNS TABLE(assertion_id text,replayed boolean) AS $$
DECLARE authority release_workflow_human_action_authorities%ROWTYPE;
DECLARE existing release_workflow_human_action_assertions%ROWTYPE;
BEGIN
  SELECT * INTO authority FROM release_workflow_human_action_authorities
   WHERE authority_id=p_authority_id FOR UPDATE;
  IF NOT FOUND OR authority.expires_at<=CURRENT_TIMESTAMP OR authority.actor_user_id<>p_actor_user_id
     OR authority.permission_key<>p_permission_key OR authority.operation<>p_operation
     OR authority.mutation_sha256<>p_mutation_sha256 OR authority.idempotency_key<>p_idempotency_key
     OR authority.request_id<>p_request_id OR p_operation NOT IN (
       'activation.request','activation.review','production.enable','command.request','command.review',
       'stop.request','stop_release.request','stop_release.review'
     ) OR p_mutation_sha256 !~ '^[a-f0-9]{64}$' OR p_assertion_sha256 !~ '^[a-f0-9]{64}$'
     OR p_credential_id_sha256 !~ '^[a-f0-9]{64}$' OR p_origin_sha256 !~ '^[a-f0-9]{64}$'
     OR p_policy_sha256 !~ '^[a-f0-9]{64}$' OR length(p_credential_id) NOT BETWEEN 16 AND 2048
     OR length(p_client_data_json) NOT BETWEEN 16 AND 8192 OR length(p_authenticator_data) NOT BETWEEN 16 AND 8192
     OR length(p_signature) NOT BETWEEN 16 AND 8192
     OR p_sign_count<0 OR p_sign_count>4294967295 OR p_verified_at>CURRENT_TIMESTAMP+interval '30 seconds'
     OR p_verified_at<CURRENT_TIMESTAMP-interval '2 minutes' OR p_expires_at<=CURRENT_TIMESTAMP
     OR p_expires_at>CURRENT_TIMESTAMP+interval '5 minutes' OR p_expires_at>authority.expires_at THEN
    RAISE EXCEPTION 'human action assertion invalid' USING ERRCODE='42501';
  END IF;
  SELECT * INTO existing FROM release_workflow_human_action_assertions WHERE challenge_id=p_challenge_id;
  IF FOUND THEN
    IF existing.authority_id<>p_authority_id OR existing.actor_user_id<>p_actor_user_id OR existing.permission_key<>p_permission_key
       OR existing.operation<>p_operation OR existing.mutation_sha256<>p_mutation_sha256
       OR existing.assertion_sha256<>p_assertion_sha256 OR existing.credential_id_sha256<>p_credential_id_sha256
       OR existing.origin_sha256<>p_origin_sha256 OR existing.sign_count<>p_sign_count
       OR existing.idempotency_key<>p_idempotency_key OR existing.request_id<>p_request_id
       OR existing.policy_sha256<>p_policy_sha256 OR existing.credential_id<>p_credential_id
       OR existing.client_data_json<>p_client_data_json OR existing.authenticator_data<>p_authenticator_data
       OR existing.signature<>p_signature THEN
      RAISE EXCEPTION 'human action assertion replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.challenge_id,true; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-human-credential:'||p_credential_id_sha256,0));
  IF p_sign_count>0 AND EXISTS(
    SELECT 1 FROM release_workflow_human_action_assertions prior
     WHERE prior.credential_id_sha256=p_credential_id_sha256 AND prior.sign_count>=p_sign_count
  ) THEN
    RAISE EXCEPTION 'human action assertion counter replayed' USING ERRCODE='42501';
  END IF;
  INSERT INTO release_workflow_human_action_assertions(
    challenge_id,authority_id,actor_user_id,permission_key,operation,mutation_sha256,assertion_sha256,
    credential_id_sha256,origin_sha256,policy_sha256,credential_id,client_data_json,authenticator_data,signature,
    sign_count,idempotency_key,request_id,verified_at,expires_at
  ) VALUES(
    p_challenge_id,p_authority_id,p_actor_user_id,p_permission_key,p_operation,p_mutation_sha256,p_assertion_sha256,
    p_credential_id_sha256,p_origin_sha256,p_policy_sha256,p_credential_id,p_client_data_json,p_authenticator_data,p_signature,
    p_sign_count,p_idempotency_key,p_request_id,p_verified_at,p_expires_at
  );
  RETURN QUERY SELECT p_challenge_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_resolve_human_action_assertion(
  p_authority_id text,p_actor_user_id text,p_operation text,p_mutation_sha256 text,
  p_idempotency_key text,p_request_id text
) RETURNS TABLE(assertion_id text,consumed boolean) AS $$
BEGIN
  RETURN QUERY
  SELECT assertion.challenge_id,consumption.assertion_id IS NOT NULL
    FROM release_workflow_human_action_authorities authority
    JOIN release_workflow_human_action_assertions assertion ON assertion.authority_id=authority.authority_id
    LEFT JOIN release_workflow_human_action_assertion_consumptions consumption
      ON consumption.assertion_id=assertion.challenge_id
   WHERE authority.authority_id=p_authority_id AND authority.actor_user_id=p_actor_user_id
     AND authority.operation=p_operation AND authority.mutation_sha256=p_mutation_sha256
     AND authority.idempotency_key=p_idempotency_key AND authority.request_id=p_request_id
     AND (assertion.expires_at>CURRENT_TIMESTAMP OR consumption.assertion_id IS NOT NULL)
   LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_append_maintenance_audit(
  p_id text,p_session_secret text,p_action text,p_subject_type text,
  p_subject_id text,p_request_id text,p_after jsonb
) RETURNS void AS $$
DECLARE permission_key text;
DECLARE expected_subject_type text;
DECLARE actor_id text;
DECLARE command_environment text;
BEGIN
  IF jsonb_typeof(p_after)<>'object' OR octet_length(p_after::text)>8192
     OR length(p_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'maintenance audit invalid' USING ERRCODE='22023';
  END IF;
  IF p_action='release.workflow.activation.requested' THEN
    permission_key:='maint.releases.workflow.activation.request'; expected_subject_type:='release_workflow_activation_request';
  ELSIF p_action='release.workflow.activation.reviewed' THEN
    permission_key:='maint.releases.workflow.activation.approve'; expected_subject_type:='release_workflow_activation_request';
  ELSIF p_action='release.workflow.production.enabled' THEN
    permission_key:='maint.releases.workflow.production.enable'; expected_subject_type:='release_workflow_activation';
  ELSIF p_action='release.workflow.command.requested' THEN
    permission_key:=CASE WHEN p_after->>'environment'='staging' THEN 'maint.releases.workflow.stage' ELSE 'maint.releases.workflow.production.request' END;
    expected_subject_type:='release_workflow_command_request';
  ELSIF p_action='release.workflow.command.reviewed' THEN
    SELECT environment INTO command_environment FROM release_workflow_command_requests WHERE id=p_subject_id;
    permission_key:=CASE WHEN command_environment='staging' THEN 'maint.releases.workflow.stage' ELSE 'maint.releases.workflow.production.approve' END;
    expected_subject_type:='release_workflow_command_request';
  ELSIF p_action='release.workflow.stop.requested' THEN
    permission_key:='maint.releases.workflow.stop'; expected_subject_type:='release_workflow_environment';
  ELSIF p_action IN ('release.workflow.stop_release.requested','release.workflow.stop_release.approved') THEN
    permission_key:='maint.releases.workflow.stop.release'; expected_subject_type:='release_workflow_stop_release_request';
  ELSE
    RAISE EXCEPTION 'maintenance audit action invalid' USING ERRCODE='22023';
  END IF;
  IF p_subject_type<>expected_subject_type OR command_environment IS NULL AND p_action='release.workflow.command.reviewed' THEN
    RAISE EXCEPTION 'maintenance audit subject invalid' USING ERRCODE='22023';
  END IF;
  SELECT authority.actor_user_id INTO actor_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,permission_key) authority;
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(p_id,actor_id,p_action,p_subject_type,p_subject_id,p_after::text,p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_request_activation_v2(
  p_id text,p_release_version_id text,p_environment text,p_session_secret text,
  p_reason text,p_idempotency_key text,p_request_id text,p_expires_at timestamptz
) RETURNS TABLE(activation_request_id text,replayed boolean) AS $$
DECLARE existing release_workflow_activation_requests%ROWTYPE;
DECLARE actor_id text;
DECLARE release_record release_versions%ROWTYPE;
DECLARE artifact release_workflow_artifact_manifests%ROWTYPE;
DECLARE bundle release_workflow_control_bundles%ROWTYPE;
BEGIN
  SELECT authority.actor_user_id INTO actor_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.activation.request') authority;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-activation-request:'||actor_id||':'||p_idempotency_key,0));
  SELECT * INTO existing FROM release_workflow_activation_requests
   WHERE requested_by_user_id=actor_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.release_version_id<>p_release_version_id OR existing.environment<>p_environment
       OR existing.reason<>p_reason
       OR existing.request_id<>p_request_id OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'activation request replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true; RETURN;
  END IF;
  SELECT candidate.* INTO release_record FROM release_versions candidate
    JOIN release_verifications verification ON verification.release_version_id=candidate.id AND verification.decision='approve'
   WHERE candidate.id=p_release_version_id;
  SELECT * INTO artifact FROM release_workflow_artifact_manifests
   WHERE release_version_id=p_release_version_id;
  SELECT * INTO bundle FROM release_workflow_control_bundles
   WHERE environment=p_environment AND artifact_manifest_sha256=artifact.artifact_manifest_sha256
     AND expires_at>CURRENT_TIMESTAMP
   ORDER BY registered_at DESC,id DESC LIMIT 1 FOR SHARE;
  IF release_record.id IS NULL OR artifact.release_version_id IS NULL OR bundle.id IS NULL
     OR artifact.artifact_manifest_sha256<>release_record.artifact_sha256
     OR artifact.migration_version<>release_record.migration_version
     OR p_expires_at<=CURRENT_TIMESTAMP OR p_expires_at>bundle.expires_at
     OR p_expires_at>CURRENT_TIMESTAMP+interval '24 hours'
     OR NOT EXISTS(
       SELECT 1 FROM release_workflow_provider_bindings provider
        WHERE provider.provider_binding_sha256=bundle.provider_binding_sha256
          AND provider.material_json->>'workflowSha256'=bundle.workflow_sha256
     ) THEN RAISE EXCEPTION 'activation binding unavailable' USING ERRCODE='55000'; END IF;
  INSERT INTO release_workflow_activation_requests(
    id,release_version_id,control_bundle_id,environment,g7_manifest_sha256,provider_binding_sha256,artifact_manifest_sha256,
    workflow_sha256,environment_policy_sha256,runner_policy_sha256,target_binding_sha256,receipt_trust_sha256,
    auditor_trust_sha256,reviewer_allowlist_sha256,requested_by_user_id,reason,idempotency_key,request_id,expires_at
  ) VALUES(
    p_id,p_release_version_id,bundle.id,p_environment,bundle.g7_manifest_sha256,bundle.provider_binding_sha256,
    artifact.artifact_manifest_sha256,bundle.workflow_sha256,bundle.environment_policy_sha256,
    bundle.runner_policy_sha256,bundle.target_binding_sha256,bundle.receipt_trust_sha256,
    bundle.auditor_trust_sha256,bundle.reviewer_allowlist_sha256,actor_id,p_reason,p_idempotency_key,p_request_id,p_expires_at
  );
  PERFORM release_workflow_append_maintenance_audit(
    p_id||'-audit',p_session_secret,'release.workflow.activation.requested',
    'release_workflow_activation_request',p_id,p_request_id,
    jsonb_build_object('releaseVersionId',p_release_version_id,'environment',p_environment,'reason',p_reason)
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_review_activation_v2(
  p_id text,p_activation_request_id text,p_session_secret text,p_approval_kind text,
  p_decision text,p_reason text,p_request_id text
) RETURNS TABLE(activation_id text,completed boolean,replayed boolean) AS $$
DECLARE requested release_workflow_activation_requests%ROWTYPE;
DECLARE existing release_workflow_activation_request_reviews%ROWTYPE;
DECLARE security_review release_workflow_activation_request_reviews%ROWTYPE;
DECLARE release_review release_workflow_activation_request_reviews%ROWTYPE;
DECLARE reviewer_id text;
BEGIN
  SELECT authority.actor_user_id INTO reviewer_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.activation.approve') authority;
  SELECT * INTO requested FROM release_workflow_activation_requests WHERE id=p_activation_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation request not found' USING ERRCODE='P0002'; END IF;
  IF requested.requested_by_user_id=reviewer_id THEN RAISE EXCEPTION 'activation self approval forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM release_workflow_activation_request_reviews
   WHERE activation_request_id=p_activation_request_id AND approval_kind=p_approval_kind;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.reviewer_user_id<>reviewer_id OR existing.decision<>p_decision
       OR existing.reason<>p_reason OR existing.request_id<>p_request_id THEN
      RAISE EXCEPTION 'activation review replay mismatch' USING ERRCODE='23505';
    END IF;
  ELSE
    INSERT INTO release_workflow_activation_request_reviews(
      id,activation_request_id,approval_kind,decision,reviewer_user_id,reason,request_id
    ) VALUES(p_id,p_activation_request_id,p_approval_kind,p_decision,reviewer_id,p_reason,p_request_id);
    PERFORM release_workflow_append_maintenance_audit(
      p_id||'-audit',p_session_secret,'release.workflow.activation.reviewed',
      'release_workflow_activation_request',p_activation_request_id,p_request_id,
      jsonb_build_object('approvalKind',p_approval_kind,'decision',p_decision,'reason',p_reason)
    );
  END IF;
  SELECT * INTO security_review FROM release_workflow_activation_request_reviews
   WHERE activation_request_id=p_activation_request_id AND approval_kind='security' AND decision='approve';
  SELECT * INTO release_review FROM release_workflow_activation_request_reviews
   WHERE activation_request_id=p_activation_request_id AND approval_kind='release' AND decision='approve';
  IF security_review.id IS NOT NULL AND release_review.id IS NOT NULL THEN
    IF security_review.reviewer_user_id=release_review.reviewer_user_id THEN
      RAISE EXCEPTION 'activation dual control required' USING ERRCODE='42501';
    END IF;
    PERFORM release_workflow_record_activation(
      requested.id,requested.environment,requested.g7_manifest_sha256,requested.provider_binding_sha256,
      requested.artifact_manifest_sha256,requested.workflow_sha256,requested.environment_policy_sha256,
      requested.runner_policy_sha256,requested.target_binding_sha256,requested.receipt_trust_sha256,
      requested.auditor_trust_sha256,requested.reviewer_allowlist_sha256,security_review.reviewer_user_id,
      release_review.reviewer_user_id,requested.reason,requested.expires_at
    );
    RETURN QUERY SELECT requested.id,true,existing.id IS NOT NULL; RETURN;
  END IF;
  RETURN QUERY SELECT NULL::text,false,existing.id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_enable_first_production_v2(
  p_id text,p_activation_id text,p_session_secret text,p_reason text,p_request_id text,p_expires_at timestamptz
) RETURNS TABLE(enablement_id text,replayed boolean) AS $$
DECLARE activation release_workflow_activations%ROWTYPE;
DECLARE result record;
DECLARE actor_id text;
DECLARE mfa_evidence_sha256 text;
BEGIN
  SELECT authority.actor_user_id,authority.recent_mfa_evidence_sha256 INTO actor_id,mfa_evidence_sha256
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.production.enable') authority;
  SELECT * INTO activation FROM release_workflow_activations WHERE id=p_activation_id;
  IF NOT FOUND OR activation.environment<>'production' OR activation.expires_at<=CURRENT_TIMESTAMP
     OR p_expires_at<=CURRENT_TIMESTAMP OR p_expires_at>activation.expires_at
     OR p_expires_at>CURRENT_TIMESTAMP+interval '24 hours' THEN
    RAISE EXCEPTION 'production activation unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO result FROM release_workflow_record_first_production_enablement(
    p_id,p_activation_id,actor_id,mfa_evidence_sha256,activation.g7_manifest_sha256,
    activation.provider_binding_sha256,activation.workflow_sha256,activation.target_binding_sha256,
    activation.receipt_trust_sha256,p_reason,p_expires_at
  );
  IF NOT result.replayed THEN
    PERFORM release_workflow_append_maintenance_audit(
      p_id||'-audit',p_session_secret,'release.workflow.production.enabled',
      'release_workflow_activation',p_activation_id,p_request_id,
      jsonb_build_object('reason',p_reason,'expiresAt',p_expires_at)
    );
  END IF;
  RETURN QUERY SELECT result.enablement_id,result.replayed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_request_command_v2(
  p_id text,p_release_version_id text,p_environment text,p_action text,p_session_secret text,
  p_reason text,p_idempotency_key text,p_request_id text
) RETURNS TABLE(command_request_id text,replayed boolean) AS $$
DECLARE existing release_workflow_command_requests%ROWTYPE;
DECLARE activation release_workflow_activations%ROWTYPE;
DECLARE release_record release_versions%ROWTYPE;
DECLARE artifact release_workflow_artifact_manifests%ROWTYPE;
DECLARE actor_id text;
DECLARE material jsonb;
BEGIN
  IF p_environment NOT IN ('staging','production') OR p_action NOT IN ('deploy','rollback') THEN
    RAISE EXCEPTION 'command intent invalid' USING ERRCODE='22023';
  END IF;
  SELECT authority.actor_user_id INTO actor_id
    FROM release_workflow_require_maintenance_actor(
      p_session_secret,
      CASE WHEN p_environment='staging' THEN 'maint.releases.workflow.stage'
           ELSE 'maint.releases.workflow.production.request' END
    ) authority;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-command-request:'||actor_id||':'||p_idempotency_key,0));
  SELECT * INTO existing FROM release_workflow_command_requests
   WHERE requested_by_user_id=actor_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.release_version_id<>p_release_version_id OR existing.environment<>p_environment
       OR existing.action<>p_action OR existing.reason<>p_reason OR existing.request_id<>p_request_id THEN
      RAISE EXCEPTION 'command request replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true; RETURN;
  END IF;
  SELECT * INTO release_record FROM release_versions WHERE id=p_release_version_id;
  SELECT * INTO artifact FROM release_workflow_artifact_manifests WHERE release_version_id=p_release_version_id;
  SELECT * INTO activation FROM release_workflow_activations
   WHERE environment=p_environment AND artifact_manifest_sha256=release_record.artifact_sha256
     AND expires_at>CURRENT_TIMESTAMP
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF activation.id IS NULL OR release_record.id IS NULL OR artifact.release_version_id IS NULL
     OR activation.artifact_manifest_sha256<>release_record.artifact_sha256
     OR artifact.artifact_manifest_sha256<>release_record.artifact_sha256
     OR artifact.migration_version<>release_record.migration_version
     OR activation.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'command activation unavailable' USING ERRCODE='55000';
  END IF;
  IF p_environment='production' AND release_record.created_by_user_id=actor_id THEN
    RAISE EXCEPTION 'production release creator cannot request command' USING ERRCODE='42501';
  END IF;
  material:=jsonb_build_object(
    'imageDigests',jsonb_build_object(
      'client',artifact.client_image_sha256,'operations',artifact.operations_image_sha256,
      'maintenance',artifact.maintenance_image_sha256,'runtime',artifact.runtime_image_sha256
    ),
    'migrationSetSha256',artifact.migration_set_sha256,
    'hasIrreversibleMigrations',artifact.has_irreversible_migrations,
    'materialSha256',artifact.material_sha256,
    'provenanceEvidenceSha256',artifact.provenance_evidence_sha256,
    'rollbackEvidenceSha256',NULL,
    'rollbackEvidenceExpiresAt',NULL
  );
  INSERT INTO release_workflow_command_requests(
    id,release_version_id,environment,action,activation_id,material_json,reason,
    requested_by_user_id,idempotency_key,request_id
  ) VALUES(p_id,p_release_version_id,p_environment,p_action,activation.id,material,p_reason,
    actor_id,p_idempotency_key,p_request_id);
  PERFORM release_workflow_append_maintenance_audit(
    p_id||'-audit',p_session_secret,'release.workflow.command.requested',
    'release_workflow_command_request',p_id,p_request_id,
    jsonb_build_object('releaseVersionId',p_release_version_id,'environment',p_environment,'action',p_action,'reason',p_reason)
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_review_command_v2(
  p_id text,p_command_request_id text,p_expected_environment text,p_session_secret text,p_decision text,
  p_reason text,p_request_id text,p_expires_at timestamptz
) RETURNS TABLE(command_id text,decision text,replayed boolean) AS $$
DECLARE requested release_workflow_command_requests%ROWTYPE;
DECLARE existing release_workflow_command_request_reviews%ROWTYPE;
DECLARE activation release_workflow_activations%ROWTYPE;
DECLARE release_record release_versions%ROWTYPE;
DECLARE artifact release_workflow_artifact_manifests%ROWTYPE;
DECLARE provider release_workflow_provider_bindings%ROWTYPE;
DECLARE enablement release_workflow_first_production_enablements%ROWTYPE;
DECLARE target_history_receipt release_workflow_receipts%ROWTYPE;
DECLARE current_history_receipt release_workflow_receipts%ROWTYPE;
DECLARE current_command release_workflow_commands%ROWTYPE;
DECLARE restore_capability release_workflow_restore_capabilities%ROWTYPE;
DECLARE staging_receipt_sha text;
DECLARE environment_state release_workflow_environment_states%ROWTYPE;
DECLARE approved_at timestamptz;
DECLARE effective_expiry timestamptz;
DECLARE activation_sha text;
DECLARE enablement_sha text;
DECLARE snapshot_core jsonb;
DECLARE snapshot jsonb;
DECLARE snapshot_sha text;
DECLARE canonical_sha text;
DECLARE reviewer_id text;
DECLARE rollback_evidence_sha text;
DECLARE rollback_evidence_expiry timestamptz;
DECLARE rollback_recovery jsonb;
BEGIN
  IF p_expected_environment NOT IN ('staging','production') THEN
    RAISE EXCEPTION 'command environment invalid' USING ERRCODE='22023';
  END IF;
  SELECT authority.actor_user_id INTO reviewer_id
    FROM release_workflow_require_maintenance_actor(
      p_session_secret,
      CASE WHEN p_expected_environment='staging' THEN 'maint.releases.workflow.stage'
           ELSE 'maint.releases.workflow.production.approve' END
    ) authority;
  SELECT * INTO requested FROM release_workflow_command_requests WHERE id=p_command_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'command request not found' USING ERRCODE='P0002'; END IF;
  IF requested.environment<>p_expected_environment THEN RAISE EXCEPTION 'command environment mismatch' USING ERRCODE='42501'; END IF;
  IF requested.requested_by_user_id=reviewer_id THEN RAISE EXCEPTION 'command self approval forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM release_workflow_command_request_reviews WHERE command_request_id=p_command_request_id;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.reviewer_user_id<>reviewer_id OR existing.decision<>p_decision
       OR existing.reason<>p_reason OR existing.request_id<>p_request_id OR existing.expires_at<>p_expires_at THEN
      RAISE EXCEPTION 'command review replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT requested.id,existing.decision,true; RETURN;
  END IF;
  SELECT * INTO release_record FROM release_versions WHERE id=requested.release_version_id;
  IF release_record.created_by_user_id=reviewer_id THEN
    RAISE EXCEPTION 'release creator cannot approve command' USING ERRCODE='42501';
  END IF;
  INSERT INTO release_workflow_command_request_reviews(
    id,command_request_id,decision,reviewer_user_id,reason,expires_at,request_id
  ) VALUES(p_id,p_command_request_id,p_decision,reviewer_id,p_reason,p_expires_at,p_request_id);
  PERFORM release_workflow_append_maintenance_audit(
    p_id||'-audit',p_session_secret,'release.workflow.command.reviewed',
    'release_workflow_command_request',p_command_request_id,p_request_id,
    jsonb_build_object('environment',requested.environment,'decision',p_decision,'reason',p_reason,'expiresAt',p_expires_at)
  );
  IF p_decision='reject' THEN RETURN QUERY SELECT requested.id,p_decision,false; RETURN; END IF;
  SELECT * INTO artifact FROM release_workflow_artifact_manifests WHERE release_version_id=requested.release_version_id;
  SELECT * INTO activation FROM release_workflow_activations WHERE id=requested.activation_id;
  SELECT * INTO provider FROM release_workflow_provider_bindings
   WHERE provider_binding_sha256=activation.provider_binding_sha256;
  SELECT * INTO environment_state FROM release_workflow_environment_states
   WHERE environment=requested.environment FOR UPDATE;
  approved_at:=clock_timestamp();
  effective_expiry:=LEAST(p_expires_at,activation.expires_at);
  IF activation.id IS NULL OR artifact.release_version_id IS NULL OR provider.provider_binding_sha256 IS NULL
     OR effective_expiry<=approved_at OR effective_expiry>approved_at+interval '24 hours'
     OR artifact.artifact_manifest_sha256<>release_record.artifact_sha256
     OR artifact.migration_version<>release_record.migration_version
     OR requested.material_json->'imageDigests' IS DISTINCT FROM jsonb_build_object(
       'client',artifact.client_image_sha256,'operations',artifact.operations_image_sha256,
       'maintenance',artifact.maintenance_image_sha256,'runtime',artifact.runtime_image_sha256
     )
     OR requested.material_json->>'migrationSetSha256' IS DISTINCT FROM artifact.migration_set_sha256
     OR (requested.material_json->>'hasIrreversibleMigrations')::boolean IS DISTINCT FROM artifact.has_irreversible_migrations
     OR requested.material_json->>'materialSha256' IS DISTINCT FROM artifact.material_sha256
     OR requested.material_json->>'provenanceEvidenceSha256' IS DISTINCT FROM artifact.provenance_evidence_sha256
     OR environment_state.stop_requested OR environment_state.blocked THEN
    RAISE EXCEPTION 'command approval binding unavailable' USING ERRCODE='55000';
  END IF;
  IF requested.environment='production' THEN
    SELECT * INTO enablement FROM release_workflow_first_production_enablements
     WHERE activation_id=activation.id AND expires_at>approved_at
     ORDER BY created_at DESC,id DESC LIMIT 1;
    SELECT receipt.payload_sha256 INTO staging_receipt_sha
      FROM release_workflow_receipts receipt
      JOIN release_workflow_target_operations operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands command ON command.id=operation.command_id
     WHERE command.environment='staging' AND command.release_version_id=requested.release_version_id
       AND command.artifact_manifest_sha256=activation.artifact_manifest_sha256
       AND receipt.phase='health_verified' AND receipt.signature_verified
       AND receipt.received_at>approved_at-interval '24 hours'
       AND receipt.payload_json->>'releaseVersionId'=requested.release_version_id
       AND receipt.payload_json->>'artifactManifestSha256'=activation.artifact_manifest_sha256
       AND receipt.payload_json->'imageDigests'=requested.material_json->'imageDigests'
       AND receipt.payload_json->>'migrationRegistrySha256'=requested.material_json->>'migrationSetSha256'
     ORDER BY receipt.received_at DESC,receipt.id DESC LIMIT 1;
    IF enablement.id IS NULL OR staging_receipt_sha IS NULL THEN
      RAISE EXCEPTION 'production prerequisites unavailable' USING ERRCODE='55000';
    END IF;
  END IF;
  IF requested.action='rollback' THEN
    rollback_evidence_expiry:=LEAST(effective_expiry,approved_at+interval '30 minutes');
    IF environment_state.expected_current_release_version_id IS NULL THEN
      RAISE EXCEPTION 'rollback current release unavailable' USING ERRCODE='55000';
    END IF;
    SELECT receipt.* INTO target_history_receipt
      FROM release_workflow_receipts receipt
      JOIN release_workflow_target_operations operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands command ON command.id=operation.command_id
     WHERE command.release_version_id=requested.release_version_id
       AND command.environment=requested.environment
       AND receipt.phase='health_verified' AND receipt.signature_verified
     ORDER BY receipt.received_at DESC,receipt.id DESC LIMIT 1;
    SELECT receipt.* INTO current_history_receipt
      FROM release_workflow_receipts receipt
      JOIN release_workflow_target_operations operation ON operation.id=receipt.operation_id
      JOIN release_workflow_commands command ON command.id=operation.command_id
     WHERE command.release_version_id=environment_state.expected_current_release_version_id
       AND command.environment=requested.environment
       AND receipt.phase='health_verified' AND receipt.signature_verified
     ORDER BY receipt.received_at DESC,receipt.id DESC LIMIT 1;
    SELECT * INTO current_command FROM release_workflow_commands WHERE id=current_history_receipt.command_id;
    SELECT * INTO restore_capability
      FROM release_workflow_restore_capabilities capability
     WHERE capability.environment=requested.environment
       AND capability.current_release_version_id=environment_state.expected_current_release_version_id
       AND capability.target_release_version_id=requested.release_version_id
       AND capability.restore_drill_result='passed'
       AND capability.target_manifest_compatible
       AND capability.target_manifest_sha256=release_record.artifact_sha256
       AND capability.minimum_migration_version<=release_record.migration_version
       AND capability.maximum_migration_version>=current_command.snapshot_json->>'migrationVersion'
       AND capability.verified_at>approved_at-interval '30 days'
       AND capability.verified_at<=approved_at
       AND capability.retention_deadline>effective_expiry
     ORDER BY capability.verified_at DESC,capability.id DESC LIMIT 1 FOR SHARE;
    IF target_history_receipt.id IS NULL OR current_history_receipt.id IS NULL OR current_command.id IS NULL
       OR restore_capability.id IS NULL
       OR target_history_receipt.received_at>=current_history_receipt.received_at
       OR target_history_receipt.payload_json->>'artifactManifestSha256' IS DISTINCT FROM release_record.artifact_sha256
       OR target_history_receipt.payload_json->'imageDigests' IS DISTINCT FROM requested.material_json->'imageDigests'
       OR target_history_receipt.payload_json->>'migrationRegistrySha256' IS DISTINCT FROM requested.material_json->>'migrationSetSha256'
       OR current_command.snapshot_json->>'migrationSetSha256' IS DISTINCT FROM requested.material_json->>'migrationSetSha256'
       OR EXISTS(
         SELECT 1 FROM release_workflow_receipts receipt
         JOIN release_workflow_target_operations operation ON operation.id=receipt.operation_id
         JOIN release_workflow_commands command ON command.id=operation.command_id
         WHERE command.environment=requested.environment
           AND receipt.phase='health_verified' AND receipt.signature_verified
           AND receipt.received_at>target_history_receipt.received_at
           AND receipt.received_at<=current_history_receipt.received_at
           AND COALESCE((command.snapshot_json->>'hasIrreversibleMigrations')::boolean,false)
       ) THEN RAISE EXCEPTION 'rollback history or recovery capability unavailable' USING ERRCODE='55000'; END IF;
    rollback_recovery:=jsonb_build_object(
      'capabilityId',restore_capability.id,
      'rehearsalBackupId',restore_capability.rehearsal_backup_id,
      'rehearsalBackupSha256',restore_capability.rehearsal_backup_sha256,
      'restoreTocSha256',restore_capability.restore_toc_sha256,
      'restorePlanSha256',restore_capability.restore_plan_sha256,
      'restoreDrillVersion',restore_capability.restore_drill_version,
      'restoreDrillResult',restore_capability.restore_drill_result,
      'verifiedAt',to_char(restore_capability.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'retentionDeadline',to_char(restore_capability.retention_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minimumMigrationVersion',restore_capability.minimum_migration_version,
      'maximumMigrationVersion',restore_capability.maximum_migration_version,
      'targetManifestSha256',restore_capability.target_manifest_sha256,
      'targetManifestCompatible',restore_capability.target_manifest_compatible,
      'compatibilityEvidenceSha256',restore_capability.compatibility_evidence_sha256
    );
    rollback_evidence_sha:=encode(sha256(convert_to(jsonb_build_object(
      'schemaVersion','1','environment',requested.environment,
      'targetReleaseVersionId',requested.release_version_id,
      'currentReleaseVersionId',environment_state.expected_current_release_version_id,
      'targetHealthReceiptSha256',target_history_receipt.payload_sha256,
      'currentHealthReceiptSha256',current_history_receipt.payload_sha256,
      'migrationSetSha256',requested.material_json->>'migrationSetSha256',
      'recoveryCapability',rollback_recovery,
      'rollbackEvidenceExpiresAt',to_char(rollback_evidence_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text,'UTF8')),'hex');
  END IF;
  activation_sha:=encode(sha256(convert_to(to_jsonb(activation)::text,'UTF8')),'hex');
  enablement_sha:=CASE WHEN enablement.id IS NULL THEN NULL ELSE encode(sha256(convert_to(to_jsonb(enablement)::text,'UTF8')),'hex') END;
  snapshot_core:=jsonb_build_object(
    'schemaVersion','1','commandId',requested.id,'releaseVersionId',requested.release_version_id,
    'environment',requested.environment,'action',requested.action,'releaseTag',release_record.version_tag,
    'releaseCommitSha',release_record.commit_sha,'imageDigests',requested.material_json->'imageDigests',
    'artifactManifestSha256',release_record.artifact_sha256,'migrationSetSha256',requested.material_json->>'migrationSetSha256',
    'migrationVersion',release_record.migration_version,'hasIrreversibleMigrations',(requested.material_json->>'hasIrreversibleMigrations')::boolean,
    'controlCommitSha',provider.material_json->>'controlCommitSha','workflowId',provider.material_json->>'workflowId',
    'workflowPath',provider.material_json->>'workflowPath','workflowSha256',activation.workflow_sha256,
    'environmentGeneration',environment_state.generation,'expectedCurrentReleaseVersionId',environment_state.expected_current_release_version_id,
    'stagingReceiptSha256',staging_receipt_sha,
    'targetHealthReceiptSha256',target_history_receipt.payload_sha256,
    'currentHealthReceiptSha256',current_history_receipt.payload_sha256,
    'rollbackEvidenceSha256',rollback_evidence_sha,
    'rollbackEvidenceExpiresAt',CASE WHEN rollback_evidence_expiry IS NULL THEN NULL ELSE to_char(rollback_evidence_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'rollbackRecoveryCapability',rollback_recovery,'g7ActivationId',activation.id,
    'g7ActivationSha256',activation_sha,'firstProductionEnablementId',enablement.id,
    'firstProductionEnablementSha256',enablement_sha,'environmentPolicySha256',activation.environment_policy_sha256,
    'runnerPolicySha256',activation.runner_policy_sha256,'reviewerAllowlistSha256',activation.reviewer_allowlist_sha256,
    'receiptTrustSha256',activation.receipt_trust_sha256,'auditorTrustSha256',activation.auditor_trust_sha256,
    'makerUserId',requested.requested_by_user_id,'checkerUserId',reviewer_id,'reason',requested.reason,
    'createdAt',to_char(requested.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'approvedAt',to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(effective_expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  snapshot_sha:=encode(sha256(convert_to(snapshot_core::text,'UTF8')),'hex');
  snapshot:=snapshot_core||jsonb_build_object('snapshotSha256',snapshot_sha);
  canonical_sha:=encode(sha256(convert_to(to_jsonb(requested)::text,'UTF8')),'hex');
  PERFORM release_workflow_request_command(
    requested.id,requested.release_version_id,requested.environment,requested.action,requested.reason,
    requested.requested_by_user_id,requested.idempotency_key,canonical_sha,snapshot_sha,snapshot,
    release_record.artifact_sha256,activation.workflow_sha256,environment_state.generation,
    environment_state.expected_current_release_version_id
  );
  PERFORM release_workflow_review_command(
    p_id||'-approval',requested.id,reviewer_id,'approve',p_reason,snapshot_sha,effective_expiry
  );
  RETURN QUERY SELECT requested.id,p_decision,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_request_stop_v2(
  p_id text,p_environment text,p_session_secret text,p_reason text,p_request_id text
) RETURNS TABLE(generation bigint,replayed boolean) AS $$
DECLARE actor_id text;
DECLARE result record;
BEGIN
  SELECT authority.actor_user_id INTO actor_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.stop') authority;
  SELECT * INTO result FROM release_workflow_request_stop(p_id,p_environment,actor_id,p_reason);
  IF NOT result.replayed THEN
    PERFORM release_workflow_append_maintenance_audit(
      p_id||'-audit',p_session_secret,'release.workflow.stop.requested',
      'release_workflow_environment',p_environment,p_request_id,
      jsonb_build_object('generation',result.generation,'reason',p_reason)
    );
  END IF;
  RETURN QUERY SELECT result.generation,result.replayed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_request_stop_release_v2(
  p_id text,p_environment text,p_activation_id text,p_session_secret text,p_reason text,
  p_idempotency_key text,p_request_id text
) RETURNS TABLE(stop_release_request_id text,replayed boolean) AS $$
DECLARE existing release_workflow_stop_release_requests%ROWTYPE;
DECLARE actor_id text;
BEGIN
  SELECT authority.actor_user_id INTO actor_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.stop.release') authority;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-stop-release-request:'||actor_id||':'||p_idempotency_key,0));
  SELECT * INTO existing FROM release_workflow_stop_release_requests
   WHERE requested_by_user_id=actor_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.environment<>p_environment OR existing.activation_id<>p_activation_id
       OR existing.reason<>p_reason OR existing.request_id<>p_request_id THEN
      RAISE EXCEPTION 'stop release request replay mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.id,true; RETURN;
  END IF;
  INSERT INTO release_workflow_stop_release_requests(
    id,environment,activation_id,requested_by_user_id,reason,idempotency_key,request_id
  ) VALUES(p_id,p_environment,p_activation_id,actor_id,p_reason,p_idempotency_key,p_request_id);
  PERFORM release_workflow_append_maintenance_audit(
    p_id||'-audit',p_session_secret,'release.workflow.stop_release.requested',
    'release_workflow_stop_release_request',p_id,p_request_id,
    jsonb_build_object('environment',p_environment,'activationId',p_activation_id,'reason',p_reason)
  );
  RETURN QUERY SELECT p_id,false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_review_stop_release_v2(
  p_id text,p_stop_release_request_id text,p_session_secret text,p_reason text,p_request_id text
) RETURNS TABLE(generation bigint,replayed boolean) AS $$
DECLARE requested release_workflow_stop_release_requests%ROWTYPE;
DECLARE existing release_workflow_stop_release_reviews%ROWTYPE;
DECLARE result record;
DECLARE reviewer_id text;
BEGIN
  SELECT authority.actor_user_id INTO reviewer_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,'maint.releases.workflow.stop.release') authority;
  SELECT * INTO requested FROM release_workflow_stop_release_requests WHERE id=p_stop_release_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stop release request not found' USING ERRCODE='P0002'; END IF;
  IF requested.requested_by_user_id=reviewer_id THEN RAISE EXCEPTION 'stop release self approval forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM release_workflow_stop_release_reviews WHERE stop_release_request_id=p_stop_release_request_id;
  IF FOUND THEN
    IF existing.id<>p_id OR existing.reviewer_user_id<>reviewer_id OR existing.reason<>p_reason
       OR existing.request_id<>p_request_id THEN RAISE EXCEPTION 'stop release review replay mismatch' USING ERRCODE='23505'; END IF;
  ELSE
    INSERT INTO release_workflow_stop_release_reviews(id,stop_release_request_id,reviewer_user_id,reason,request_id)
    VALUES(p_id,p_stop_release_request_id,reviewer_id,p_reason,p_request_id);
  END IF;
  SELECT * INTO result FROM release_workflow_clear_stop(
    requested.id||'-cleared',requested.environment,requested.requested_by_user_id,reviewer_id,
    requested.activation_id,requested.reason
  );
  IF existing.id IS NULL AND NOT result.replayed THEN
    PERFORM release_workflow_append_maintenance_audit(
      p_id||'-audit',p_session_secret,'release.workflow.stop_release.approved',
      'release_workflow_stop_release_request',p_stop_release_request_id,p_request_id,
      jsonb_build_object('generation',result.generation,'reason',p_reason)
    );
  END IF;
  RETURN QUERY SELECT result.generation,existing.id IS NOT NULL OR result.replayed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_jsonb_has_exact_keys(p_value jsonb,p_keys text[])
RETURNS boolean AS $$
  SELECT jsonb_typeof(p_value)='object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_value))=cardinality(p_keys)
     AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) key WHERE NOT key=ANY(p_keys));
$$ LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_execute_human_action(
  p_assertion_id text,p_session_secret text,p_mutation_document text,p_mutation_sha256 text
) RETURNS jsonb AS $$
DECLARE assertion release_workflow_human_action_assertions%ROWTYPE;
DECLARE authority release_workflow_human_action_authorities%ROWTYPE;
DECLARE consumed release_workflow_human_action_assertion_consumptions%ROWTYPE;
DECLARE document jsonb;
DECLARE parameters jsonb;
DECLARE body jsonb;
DECLARE operation text;
DECLARE actor_id text;
DECLARE session_actor_id text;
DECLARE idempotency_key text;
DECLARE request_id text;
DECLARE permission_key text;
DECLARE operation_prefix text;
DECLARE operation_id text;
DECLARE environment text;
DECLARE result_json jsonb;
DECLARE expires_at timestamptz;
BEGIN
  IF length(p_mutation_document) NOT BETWEEN 32 AND 32768
     OR p_mutation_sha256 !~ '^[a-f0-9]{64}$'
     OR encode(sha256(convert_to(p_mutation_document,'UTF8')),'hex')<>p_mutation_sha256 THEN
    RAISE EXCEPTION 'human action mutation digest invalid' USING ERRCODE='42501';
  END IF;
  document:=p_mutation_document::jsonb;
  IF NOT release_workflow_jsonb_has_exact_keys(document,ARRAY[
       'schemaVersion','operation','actorUserId','sessionSecretSha256','idempotencyKey','requestId','parameters','body'
     ]) OR document->>'schemaVersion'<>'1'
     OR document->>'sessionSecretSha256'<>encode(sha256(convert_to(p_session_secret,'UTF8')),'hex')
     OR length(document->>'actorUserId') NOT BETWEEN 3 AND 160
     OR length(document->>'idempotencyKey') NOT BETWEEN 8 AND 160
     OR length(document->>'requestId') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'human action mutation document invalid' USING ERRCODE='42501';
  END IF;
  operation:=document->>'operation'; actor_id:=document->>'actorUserId';
  idempotency_key:=document->>'idempotencyKey'; request_id:=document->>'requestId';
  parameters:=document->'parameters'; body:=document->'body';
  IF jsonb_typeof(parameters)<>'object' OR jsonb_typeof(body)<>'object' OR octet_length(body::text)>8192 THEN
    RAISE EXCEPTION 'human action payload invalid' USING ERRCODE='22023';
  END IF;
  environment:=COALESCE(parameters->>'environment',body->>'environment');
  permission_key:=CASE operation
    WHEN 'activation.request' THEN 'maint.releases.workflow.activation.request'
    WHEN 'activation.review' THEN 'maint.releases.workflow.activation.approve'
    WHEN 'production.enable' THEN 'maint.releases.workflow.production.enable'
    WHEN 'command.request' THEN CASE WHEN environment='staging' THEN 'maint.releases.workflow.stage' ELSE 'maint.releases.workflow.production.request' END
    WHEN 'command.review' THEN CASE WHEN environment='staging' THEN 'maint.releases.workflow.stage' ELSE 'maint.releases.workflow.production.approve' END
    WHEN 'stop.request' THEN 'maint.releases.workflow.stop'
    WHEN 'stop_release.request' THEN 'maint.releases.workflow.stop.release'
    WHEN 'stop_release.review' THEN 'maint.releases.workflow.stop.release'
    ELSE NULL END;
  operation_prefix:=CASE operation
    WHEN 'activation.request' THEN 'activation-request'
    WHEN 'activation.review' THEN 'activation-review'
    WHEN 'production.enable' THEN 'production-enablement'
    WHEN 'command.request' THEN 'command-request'
    WHEN 'command.review' THEN 'command-review'
    WHEN 'stop.request' THEN 'stop-request'
    WHEN 'stop_release.request' THEN 'stop-release-request'
    WHEN 'stop_release.review' THEN 'stop-release-review'
    ELSE NULL END;
  IF permission_key IS NULL THEN RAISE EXCEPTION 'human action operation invalid' USING ERRCODE='22023'; END IF;
  operation_id:=operation_prefix||'-'||substr(encode(sha256(
    convert_to(actor_id,'UTF8')||decode('00','hex')||convert_to(operation_prefix,'UTF8')
      ||decode('00','hex')||convert_to(idempotency_key,'UTF8')
  ),'hex'),1,48);

  SELECT * INTO assertion FROM release_workflow_human_action_assertions
   WHERE challenge_id=p_assertion_id FOR UPDATE;
  IF NOT FOUND OR assertion.actor_user_id<>actor_id OR assertion.permission_key<>permission_key
     OR assertion.operation<>operation OR assertion.mutation_sha256<>p_mutation_sha256
     OR assertion.idempotency_key<>idempotency_key OR assertion.request_id<>request_id THEN
    RAISE EXCEPTION 'exact human action assertion unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO authority FROM release_workflow_human_action_authorities
   WHERE authority_id=assertion.authority_id FOR SHARE;
  IF NOT FOUND OR authority.actor_user_id<>actor_id OR authority.permission_key<>permission_key
     OR authority.operation<>operation OR authority.mutation_sha256<>p_mutation_sha256
     OR authority.session_secret_sha256<>document->>'sessionSecretSha256'
     OR authority.session_secret_sha256<>encode(sha256(convert_to(p_session_secret,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'human action session authority mismatch' USING ERRCODE='42501';
  END IF;
  SELECT verified.actor_user_id INTO session_actor_id
    FROM release_workflow_require_maintenance_actor(p_session_secret,permission_key) verified;
  IF session_actor_id<>actor_id THEN
    RAISE EXCEPTION 'human action session actor mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO consumed FROM release_workflow_human_action_assertion_consumptions
   WHERE assertion_id=p_assertion_id;
  IF FOUND THEN
    IF consumed.actor_user_id<>actor_id OR consumed.operation<>operation
       OR consumed.mutation_sha256<>p_mutation_sha256 OR consumed.idempotency_key<>idempotency_key
       OR consumed.request_id<>request_id OR consumed.operation_id<>operation_id THEN
      RAISE EXCEPTION 'human action assertion consumption mismatch' USING ERRCODE='23505';
    END IF;
    RETURN consumed.result_json;
  END IF;
  IF assertion.expires_at<=CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'human action assertion expired' USING ERRCODE='42501';
  END IF;

  IF operation='activation.request' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY[]::text[])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['releaseVersionId','environment','reason','expiresAt'])
       OR body->>'environment' NOT IN ('staging','production') THEN
      RAISE EXCEPTION 'activation request payload invalid' USING ERRCODE='22023';
    END IF;
    expires_at:=(body->>'expiresAt')::timestamptz;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_request_activation_v2(
      operation_id,body->>'releaseVersionId',body->>'environment',p_session_secret,
      btrim(body->>'reason'),idempotency_key,request_id,expires_at
    ) result;
  ELSIF operation='activation.review' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['activationRequestId'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['approvalKind','decision','reason'])
       OR body->>'approvalKind' NOT IN ('security','release') OR body->>'decision' NOT IN ('approve','reject') THEN
      RAISE EXCEPTION 'activation review payload invalid' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_review_activation_v2(
      operation_id,parameters->>'activationRequestId',p_session_secret,body->>'approvalKind',
      body->>'decision',btrim(body->>'reason'),request_id
    ) result;
  ELSIF operation='production.enable' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['activationId'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['reason','expiresAt']) THEN
      RAISE EXCEPTION 'production enable payload invalid' USING ERRCODE='22023';
    END IF;
    expires_at:=(body->>'expiresAt')::timestamptz;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_enable_first_production_v2(
      operation_id,parameters->>'activationId',p_session_secret,btrim(body->>'reason'),request_id,expires_at
    ) result;
  ELSIF operation='command.request' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['releaseVersionId','environment'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['environment','action','reason'])
       OR parameters->>'environment' NOT IN ('staging','production')
       OR body->>'environment'<>parameters->>'environment' OR body->>'action' NOT IN ('deploy','rollback') THEN
      RAISE EXCEPTION 'command request payload invalid' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_request_command_v2(
      operation_id,parameters->>'releaseVersionId',parameters->>'environment',body->>'action',p_session_secret,
      btrim(body->>'reason'),idempotency_key,request_id
    ) result;
  ELSIF operation='command.review' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['commandRequestId','environment'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['decision','reason','expiresAt'])
       OR parameters->>'environment' NOT IN ('staging','production') OR body->>'decision' NOT IN ('approve','reject') THEN
      RAISE EXCEPTION 'command review payload invalid' USING ERRCODE='22023';
    END IF;
    expires_at:=(body->>'expiresAt')::timestamptz;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_review_command_v2(
      operation_id,parameters->>'commandRequestId',parameters->>'environment',p_session_secret,
      body->>'decision',btrim(body->>'reason'),request_id,expires_at
    ) result;
  ELSIF operation='stop.request' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['environment'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['reason'])
       OR parameters->>'environment' NOT IN ('staging','production') THEN
      RAISE EXCEPTION 'stop request payload invalid' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_request_stop_v2(
      operation_id,parameters->>'environment',p_session_secret,btrim(body->>'reason'),request_id
    ) result;
  ELSIF operation='stop_release.request' THEN
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY[]::text[])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['environment','activationId','reason'])
       OR body->>'environment' NOT IN ('staging','production') THEN
      RAISE EXCEPTION 'stop release request payload invalid' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_request_stop_release_v2(
      operation_id,body->>'environment',body->>'activationId',p_session_secret,btrim(body->>'reason'),
      idempotency_key,request_id
    ) result;
  ELSE
    IF NOT release_workflow_jsonb_has_exact_keys(parameters,ARRAY['stopReleaseRequestId'])
       OR NOT release_workflow_jsonb_has_exact_keys(body,ARRAY['reason']) THEN
      RAISE EXCEPTION 'stop release review payload invalid' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(result) INTO result_json FROM release_workflow_review_stop_release_v2(
      operation_id,parameters->>'stopReleaseRequestId',p_session_secret,btrim(body->>'reason'),request_id
    ) result;
  END IF;
  IF result_json IS NULL OR jsonb_typeof(result_json)<>'object' THEN
    RAISE EXCEPTION 'human action result unavailable' USING ERRCODE='55000';
  END IF;
  INSERT INTO release_workflow_human_action_assertion_consumptions(
    assertion_id,actor_user_id,operation,mutation_sha256,idempotency_key,request_id,operation_id,result_json
  ) VALUES(p_assertion_id,actor_id,operation,p_mutation_sha256,idempotency_key,request_id,operation_id,result_json);
  RETURN result_json;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION release_workflow_read_maintenance_control(p_limit integer DEFAULT 50)
RETURNS jsonb AS $$
BEGIN
  IF p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'limit invalid' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object(
    'environments',(SELECT COALESCE(jsonb_agg(to_jsonb(state) ORDER BY state.environment),'[]'::jsonb)
      FROM release_workflow_environment_states AS state),
    'commands',(SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC,item.command_id DESC),'[]'::jsonb)
      FROM (SELECT * FROM release_workflow_safe_status ORDER BY created_at DESC,command_id DESC LIMIT p_limit) AS item),
    'commandRequests',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',request.id,'releaseVersionId',request.release_version_id,'environment',request.environment,'action',request.action,
      'activationId',request.activation_id,'reason',request.reason,'requestedByUserId',request.requested_by_user_id,
      'material',request.material_json,'createdAt',request.created_at,'decision',review.decision,'reviewerUserId',review.reviewer_user_id
    ) ORDER BY request.created_at DESC,request.id DESC),'[]'::jsonb)
      FROM (SELECT * FROM release_workflow_command_requests ORDER BY created_at DESC,id DESC LIMIT p_limit) request
      LEFT JOIN release_workflow_command_request_reviews review ON review.command_request_id=request.id),
    'activationRequests',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',request.id,'releaseVersionId',request.release_version_id,'controlBundleId',request.control_bundle_id,
      'environment',request.environment,'artifactManifestSha256',request.artifact_manifest_sha256,
      'controlBinding',jsonb_build_object(
        'g7ManifestSha256',request.g7_manifest_sha256,'providerBindingSha256',request.provider_binding_sha256,
        'workflowSha256',request.workflow_sha256,'environmentPolicySha256',request.environment_policy_sha256,
        'runnerPolicySha256',request.runner_policy_sha256,'targetBindingSha256',request.target_binding_sha256,
        'receiptTrustSha256',request.receipt_trust_sha256,'auditorTrustSha256',request.auditor_trust_sha256,
        'reviewerAllowlistSha256',request.reviewer_allowlist_sha256,
        'provenanceEvidenceSha256',bundle.provenance_evidence_sha256
      ),
      'requestedByUserId',request.requested_by_user_id,'reason',request.reason,'expiresAt',request.expires_at,
      'createdAt',request.created_at,'securityDecision',security.decision,'securityReviewerUserId',security.reviewer_user_id,
      'releaseDecision',release_review.decision,'releaseReviewerUserId',release_review.reviewer_user_id,
      'active',activation.id IS NOT NULL
    ) ORDER BY request.created_at DESC,request.id DESC),'[]'::jsonb)
      FROM (SELECT * FROM release_workflow_activation_requests ORDER BY created_at DESC,id DESC LIMIT p_limit) request
      JOIN release_workflow_control_bundles bundle ON bundle.id=request.control_bundle_id
      LEFT JOIN release_workflow_activation_request_reviews security
        ON security.activation_request_id=request.id AND security.approval_kind='security'
      LEFT JOIN release_workflow_activation_request_reviews release_review
        ON release_review.activation_request_id=request.id AND release_review.approval_kind='release'
      LEFT JOIN release_workflow_activations activation ON activation.id=request.id),
    'stopReleases',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',request.id,'environment',request.environment,'activationId',request.activation_id,'reason',request.reason,
      'requestedByUserId',request.requested_by_user_id,'createdAt',request.created_at,
      'reviewerUserId',review.reviewer_user_id,'reviewedAt',review.created_at
    ) ORDER BY request.created_at DESC,request.id DESC),'[]'::jsonb)
      FROM (SELECT * FROM release_workflow_stop_release_requests ORDER BY created_at DESC,id DESC LIMIT p_limit) request
      LEFT JOIN release_workflow_stop_release_reviews review ON review.stop_release_request_id=request.id),
    'stops',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',stop.id,'environment',stop.environment,'action',stop.action,'generation',stop.generation,
      'actorKind',stop.actor_kind,'reason',stop.reason,'activationId',stop.activation_id,'createdAt',stop.created_at
    ) ORDER BY stop.created_at DESC,stop.id DESC),'[]'::jsonb)
      FROM (SELECT * FROM release_workflow_stops ORDER BY created_at DESC,id DESC LIMIT p_limit) stop)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path FROM CURRENT;

DO $maintenance_control_acl$
DECLARE gateway record; DECLARE role_row record;
BEGIN
  FOR gateway IN SELECT procedure.oid::regprocedure AS identity FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname=current_schema() AND procedure.proname LIKE 'release\_workflow\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I',gateway.identity,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',gateway.identity);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM agentnovas_maint_web',gateway.identity);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_release_control') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM agentnovas_release_control',gateway.identity);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_release_identity_verifier') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM agentnovas_release_identity_verifier',gateway.identity);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    REVOKE EXECUTE ON FUNCTION release_workflow_request_command(text,text,text,text,text,text,text,text,text,jsonb,text,text,bigint,text) FROM agentnovas_maint_web;
    REVOKE EXECUTE ON FUNCTION release_workflow_review_command(text,text,text,text,text,text,timestamptz) FROM agentnovas_maint_web;
    REVOKE EXECUTE ON FUNCTION release_workflow_record_activation(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz) FROM agentnovas_maint_web;
    REVOKE EXECUTE ON FUNCTION release_workflow_record_provider_binding(text,jsonb) FROM agentnovas_maint_web;
    REVOKE EXECUTE ON FUNCTION release_workflow_record_first_production_enablement(text,text,text,text,text,text,text,text,text,text,timestamptz) FROM agentnovas_maint_web;
    REVOKE EXECUTE ON FUNCTION release_workflow_clear_stop(text,text,text,text,text,text) FROM agentnovas_maint_web;
  END IF;
END
$maintenance_control_acl$;

WITH synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT 'bootstrap-role-permission-'||md5(identity.role_id||':'||permission.key),identity.role_id,permission.key,'PLATFORM','[]'::jsonb
  FROM system_role_identities identity JOIN permission_definitions permission
    ON permission.application_id=identity.application_id AND permission.status='active'
  WHERE identity.system_key='bootstrap_admin' AND permission.key LIKE 'maint.releases.workflow.%'
  ON CONFLICT(role_id,permission_key) DO UPDATE SET scope='PLATFORM',scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT 'migration-0084-'||md5(role_id||':'||permission_key),NULL,'system.bootstrap_role_permission_synchronized',
  'role',role_id,jsonb_build_object('permissionKey',permission_key,'scope','PLATFORM','migration','0084_restricted_cicd_maintenance_control')::text
FROM synchronized ON CONFLICT(id) DO NOTHING;

WITH technical_role AS (
  SELECT id FROM roles WHERE application_id='maintenance' AND code='maint_technical' AND is_system=true
), desired(permission_key) AS (
  VALUES
    ('maint.releases.workflow.view'),('maint.releases.workflow.stage'),
    ('maint.releases.workflow.production.request'),('maint.releases.workflow.activation.request')
), synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT 'migration-0084-tech-permission-'||md5(technical_role.id||':'||desired.permission_key),
    technical_role.id,desired.permission_key,'PLATFORM','[]'::jsonb
  FROM technical_role CROSS JOIN desired
  ON CONFLICT(role_id,permission_key) DO UPDATE SET scope='PLATFORM',scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT 'migration-0084-tech-permission-'||md5(role_id||':'||permission_key),NULL,
  'system.technical_role_permission_synchronized','role',role_id,
  jsonb_build_object('permissionKey',permission_key,'scope','PLATFORM','migration','0084_restricted_cicd_maintenance_control')::text
FROM synchronized ON CONFLICT(id) DO NOTHING;
