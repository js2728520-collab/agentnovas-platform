WITH synchronized AS (
  INSERT INTO role_permissions (
    id, role_id, permission_key, scope, scope_organization_ids_json
  )
  SELECT
    'bootstrap-role-permission-' || md5(identity.role_id || ':' || permission.key),
    identity.role_id,
    permission.key,
    'PLATFORM',
    '[]'::jsonb
  FROM system_role_identities AS identity
  JOIN permission_definitions AS permission
    ON permission.application_id = identity.application_id
   AND permission.status = 'active'
  WHERE identity.system_key = 'bootstrap_admin'
  ON CONFLICT (role_id, permission_key) DO UPDATE
    SET scope = EXCLUDED.scope,
        scope_organization_ids_json = EXCLUDED.scope_organization_ids_json
  WHERE role_permissions.scope IS DISTINCT FROM 'PLATFORM'
     OR role_permissions.scope_organization_ids_json IS DISTINCT FROM '[]'::jsonb
  RETURNING role_id, permission_key
)
INSERT INTO audit_logs (
  id, actor_user_id, action, subject_type, subject_id, after_json
)
SELECT
  'migration-0037-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.bootstrap_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey', permission_key,
    'scope', 'PLATFORM',
    'migration', '0037_bootstrap_system_role_permission_sync'
  )::text
FROM synchronized
ON CONFLICT (id) DO NOTHING;
