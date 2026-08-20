INSERT INTO permission_definitions (
  "key", application_id, label, sensitive, status
) VALUES (
  'client.paper.manage', 'client', '启动与停止模拟策略', true, 'active'
)
ON CONFLICT ("key") DO UPDATE SET
  application_id = EXCLUDED.application_id,
  label = EXCLUDED.label,
  sensitive = EXCLUDED.sensitive,
  status = EXCLUDED.status;

INSERT INTO role_permissions (id, role_id, permission_key, scope)
SELECT role.id || ':client.paper.manage', role.id, 'client.paper.manage', 'SELF'
FROM roles AS role
WHERE role.application_id = 'client'
  AND role.code IN ('client_customer', 'client_strategy_author')
ON CONFLICT (role_id, permission_key) DO UPDATE SET
  scope = EXCLUDED.scope;
