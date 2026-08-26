INSERT INTO permission_definitions(key,application_id,label,description,sensitive,status)
VALUES (
  'maint.ai_usage.view',
  'maintenance',
  '查看 AI 用量与可靠性',
  '查看可信 Token、Credits 结算及失败率的安全聚合',
  true,
  'active'
)
ON CONFLICT(key) DO UPDATE SET
  application_id=EXCLUDED.application_id,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sensitive=EXCLUDED.sensitive,
  status=EXCLUDED.status,
  updated_at=now();

ALTER TABLE client_ai_inference_requests
  ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE client_ai_inference_requests
  ADD COLUMN IF NOT EXISTS organization_attribution_mode text;

UPDATE client_ai_inference_requests AS request
SET
  organization_id=attribution.branch_id,
  organization_attribution_mode=CASE
    WHEN attribution.branch_id IS NULL THEN 'legacy_unattributed'
    ELSE 'legacy_current_backfill'
  END
FROM (
  SELECT DISTINCT ON (active_attribution.customer_id)
    active_attribution.customer_id,
    active_attribution.branch_id
  FROM customer_attributions AS active_attribution
  WHERE active_attribution.status='active'
  ORDER BY active_attribution.customer_id,
           active_attribution.effective_at DESC NULLS LAST,
           active_attribution.created_at DESC,
           active_attribution.id DESC
) AS attribution
WHERE request.organization_attribution_mode IS NULL
  AND attribution.customer_id=request.user_id;

UPDATE client_ai_inference_requests
SET organization_attribution_mode='legacy_unattributed'
WHERE organization_attribution_mode IS NULL;

ALTER TABLE client_ai_inference_requests
  ALTER COLUMN organization_attribution_mode SET DEFAULT 'captured_at_request',
  ALTER COLUMN organization_attribution_mode SET NOT NULL;

ALTER TABLE client_ai_inference_requests
  DROP CONSTRAINT IF EXISTS client_ai_inference_organization_attribution_mode;

ALTER TABLE client_ai_inference_requests
  ADD CONSTRAINT client_ai_inference_organization_attribution_mode
  CHECK (organization_attribution_mode IN (
    'captured_at_request','legacy_current_backfill','legacy_unattributed'
  ));

CREATE OR REPLACE VIEW maintenance_ai_usage_events_safe
WITH (security_barrier = true)
AS
SELECT
  request.created_at,
  (request.created_at AT TIME ZONE 'UTC')::date AS usage_day,
  md5(request.user_id) AS user_pseudonym_source,
  COALESCE(request.organization_id, 'unattributed') AS organization_id,
  COALESCE(organization.name, '未归属') AS organization_name,
  request.organization_attribution_mode,
  request.profile_revision_id,
  revision.provider_name,
  revision.model_name,
  request.operation,
  CASE request.operation
    WHEN 'assistant_message' THEN 'report'
    WHEN 'strategy_generation' THEN 'proposal_a'
  END AS agent_role,
  CASE WHEN request.status='succeeded' THEN 1 ELSE 0 END AS succeeded_count,
  CASE
    WHEN request.status='failed' AND request.error_code<>'AI_REQUEST_CANCELLED' THEN 1
    ELSE 0
  END AS failed_count,
  CASE
    WHEN request.status='failed' AND request.error_code='AI_REQUEST_CANCELLED' THEN 1
    ELSE 0
  END AS cancelled_count,
  CASE WHEN request.status='processing' THEN 1 ELSE 0 END AS processing_count,
  CASE WHEN request.status='succeeded' THEN COALESCE(request.input_tokens,0) ELSE 0 END AS input_tokens,
  CASE WHEN request.status='succeeded' THEN COALESCE(request.output_tokens,0) ELSE 0 END AS output_tokens,
  CASE
    WHEN reservation.status='settled' THEN COALESCE(reservation.settled_credits,0)
    ELSE 0
  END AS settled_credits,
  CASE WHEN reservation.status='released' THEN 1 ELSE 0 END AS released_count
FROM client_ai_inference_requests AS request
JOIN llm_profile_revisions AS revision
  ON revision.id=request.profile_revision_id
LEFT JOIN ai_credit_reservations AS reservation
  ON reservation.id=request.reservation_id
LEFT JOIN organizations AS organization
  ON organization.id=request.organization_id;

COMMENT ON VIEW maintenance_ai_usage_events_safe IS
  'Least-privilege metering projection. Exposes only a one-way user pseudonym source; excludes raw identity fields, AI content, errors, provider request identifiers and secrets.';

WITH synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'bootstrap-role-permission-' || md5(identity.role_id || ':maint.ai_usage.view'),
    identity.role_id,
    'maint.ai_usage.view',
    'PLATFORM',
    '[]'::jsonb
  FROM system_role_identities AS identity
  WHERE identity.system_key='bootstrap_admin'
    AND identity.application_id='maintenance'
  ON CONFLICT(role_id,permission_key) DO UPDATE SET
    scope='PLATFORM',
    scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0074-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.bootstrap_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey',permission_key,
    'scope','PLATFORM',
    'migration','0074_maintenance_ai_usage_analytics'
  )::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;

-- `tech_staff` belongs to Maintenance. Older provisioning code accidentally
-- created `maint_technical` in Operations, so repair both the authoritative
-- system role and existing active/pending technical accounts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM roles
    WHERE application_id='maintenance'
      AND code='maint_technical'
      AND (is_system=false OR kind<>'system')
  ) THEN
    RAISE EXCEPTION 'MAINT_TECHNICAL_ROLE_CODE_CONFLICT';
  END IF;
END $$;

INSERT INTO roles(id,application_id,code,name,kind,status,is_system,created_by_user_id)
VALUES (
  'migration-0074-maint-technical-role',
  'maintenance',
  'maint_technical',
  '运维默认角色：tech_staff',
  'system',
  'published',
  true,
  NULL
)
ON CONFLICT(application_id,code) DO UPDATE SET
  name=EXCLUDED.name,
  kind='system',
  status='published',
  is_system=true,
  updated_at=now();

WITH technical_role AS (
  SELECT id FROM roles
  WHERE application_id='maintenance' AND code='maint_technical' AND is_system=true
), desired(permission_key) AS (
  VALUES
    ('maint.llm_profiles.manage'),
    ('maint.agent_bindings.manage'),
    ('maint.email_integrations.manage'),
    ('maint.feature_flags.manage'),
    ('maint.system_health.view'),
    ('maint.ai_usage.view'),
    ('maint.audit.view'),
    ('maint.demo_exchanges.view'),
    ('maint.demo_exchanges.verify'),
    ('maint.follow_policy.view'),
    ('maint.releases.view'),
    ('maint.releases.manage'),
    ('maint.configuration_versions.view'),
    ('maint.configuration_versions.manage')
), removed AS (
  DELETE FROM role_permissions AS permission
  USING technical_role
  WHERE permission.role_id=technical_role.id
    AND permission.permission_key NOT IN (SELECT permission_key FROM desired)
  RETURNING permission.role_id,permission.permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0074-tech-permission-removed-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.technical_role_permission_removed',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey',permission_key,
    'migration','0074_maintenance_ai_usage_analytics'
  )::text
FROM removed
ON CONFLICT(id) DO NOTHING;

WITH technical_role AS (
  SELECT id FROM roles
  WHERE application_id='maintenance' AND code='maint_technical' AND is_system=true
), desired(permission_key) AS (
  VALUES
    ('maint.llm_profiles.manage'),
    ('maint.agent_bindings.manage'),
    ('maint.email_integrations.manage'),
    ('maint.feature_flags.manage'),
    ('maint.system_health.view'),
    ('maint.ai_usage.view'),
    ('maint.audit.view'),
    ('maint.demo_exchanges.view'),
    ('maint.demo_exchanges.verify'),
    ('maint.follow_policy.view'),
    ('maint.releases.view'),
    ('maint.releases.manage'),
    ('maint.configuration_versions.view'),
    ('maint.configuration_versions.manage')
), synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'migration-0074-tech-permission-' || md5(technical_role.id || ':' || desired.permission_key),
    technical_role.id,
    desired.permission_key,
    'PLATFORM',
    '[]'::jsonb
  FROM technical_role CROSS JOIN desired
  ON CONFLICT(role_id,permission_key) DO UPDATE SET
    scope='PLATFORM',
    scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0074-tech-permission-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.technical_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey',permission_key,
    'scope','PLATFORM',
    'migration','0074_maintenance_ai_usage_analytics'
  )::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;

WITH revoked AS (
  UPDATE user_role_assignments AS assignment
  SET
    status='revoked',
    revoked_at=now(),
    reason=CASE
      WHEN assignment.reason='' THEN 'migration 0074: technical account moved to Maintenance'
      ELSE assignment.reason || '; migration 0074: technical account moved to Maintenance'
    END,
    updated_at=now()
  FROM users AS user_account,roles AS role
  WHERE assignment.user_id=user_account.id
    AND assignment.role_id=role.id
    AND user_account.role='tech_staff'
    AND assignment.application_id='operations'
    AND role.application_id='operations'
    AND role.code='maint_technical'
    AND role.is_system=true
    AND assignment.status IN ('active','pending')
  RETURNING assignment.id,assignment.user_id
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0074-tech-ops-revoked-' || md5(id),
  NULL,
  'system.technical_operations_assignment_revoked',
  'user',
  user_id,
  jsonb_build_object(
    'assignmentId',id,
    'migration','0074_maintenance_ai_usage_analytics'
  )::text
FROM revoked
ON CONFLICT(id) DO NOTHING;

WITH technical_role AS (
  SELECT id FROM roles
  WHERE application_id='maintenance' AND code='maint_technical' AND is_system=true
), inserted AS (
  INSERT INTO user_role_assignments(
    id,user_id,role_id,application_id,organization_id,
    scope_organization_ids_json,status,effective_at,reason
  )
  SELECT
    'migration-0074-tech-assignment-' || md5(user_account.id),
    user_account.id,
    technical_role.id,
    'maintenance',
    user_account.organization_id,
    '[]'::jsonb,
    'active',
    now(),
    'migration 0074: technical account assigned to Maintenance'
  FROM users AS user_account CROSS JOIN technical_role
  WHERE user_account.role='tech_staff'
    AND user_account.status IN ('active','pending')
    AND NOT EXISTS (
      SELECT 1
      FROM rbac_revocation_tombstones AS tombstone
      WHERE tombstone.user_id=user_account.id
        AND tombstone.application_id='maintenance'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_role_assignments AS active_assignment
      WHERE active_assignment.user_id=user_account.id
        AND active_assignment.application_id='maintenance'
        AND active_assignment.role_id=technical_role.id
        AND active_assignment.status='active'
        AND active_assignment.effective_at<=now()
        AND (active_assignment.expires_at IS NULL OR active_assignment.expires_at>now())
    )
  ON CONFLICT(id) DO NOTHING
  RETURNING id,user_id,role_id
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0074-tech-maint-assigned-' || md5(id),
  NULL,
  'system.technical_maintenance_assignment_created',
  'user',
  user_id,
  jsonb_build_object(
    'assignmentId',id,
    'roleId',role_id,
    'migration','0074_maintenance_ai_usage_analytics'
  )::text
FROM inserted
ON CONFLICT(id) DO NOTHING;

REVOKE ALL ON maintenance_ai_usage_events_safe FROM PUBLIC;

CREATE INDEX IF NOT EXISTS idx_client_ai_inference_requests_created
  ON client_ai_inference_requests(created_at DESC,id DESC);
