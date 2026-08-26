INSERT INTO permission_definitions(key,application_id,label,description,sensitive,status)
VALUES
  ('maint.configuration_versions.view','maintenance','查看版本化配置','查看不可变配置版本、测试、审批、调度与生效历史',false,'active'),
  ('maint.configuration_versions.manage','maintenance','管理配置草稿与测试','创建不可变配置草稿并登记测试证据',true,'active'),
  ('maint.configuration_versions.approve','maintenance','审批与调度配置','独立审批配置版本并安排生效时间',true,'active'),
  ('maint.configuration_versions.activate','maintenance','激活与回滚配置','激活到期配置或恢复历史已验证版本',true,'active')
ON CONFLICT(key) DO UPDATE SET
  application_id=EXCLUDED.application_id,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sensitive=EXCLUDED.sensitive,
  status=EXCLUDED.status,
  updated_at=now();

CREATE TABLE configuration_versions (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('brand','domain','protocol','feature_flag','prompt','skill','pricing')),
  configuration_key text NOT NULL CHECK (configuration_key ~ '^[a-z][a-z0-9_.-]{2,120}$'),
  audience text NOT NULL CHECK (audience IN ('client','operations','maintenance','shared')),
  version_number integer NOT NULL CHECK (version_number > 0),
  schema_version integer NOT NULL CHECK (schema_version BETWEEN 1 AND 1000000),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text) <= 65536),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,configuration_key,audience,version_number),
  UNIQUE(created_by_user_id,idempotency_key)
);

CREATE TABLE configuration_test_results (
  id text PRIMARY KEY,
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  configuration_version_id text NOT NULL REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('passed','failed')),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  tested_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tested_by_user_id,idempotency_key)
);

CREATE TABLE configuration_approvals (
  id text PRIMARY KEY,
  configuration_version_id text NOT NULL UNIQUE REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reviewer_user_id,idempotency_key)
);

CREATE TABLE configuration_schedules (
  id text PRIMARY KEY,
  configuration_version_id text NOT NULL UNIQUE REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  scheduled_for timestamptz NOT NULL,
  scheduled_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scheduled_by_user_id,idempotency_key)
);

CREATE TABLE configuration_activations (
  id text PRIMARY KEY,
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  configuration_version_id text NOT NULL REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  previous_configuration_version_id text REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('activate','rollback')),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_user_id,idempotency_key),
  CHECK (previous_configuration_version_id IS NULL OR previous_configuration_version_id <> configuration_version_id)
);

CREATE INDEX idx_configuration_versions_stream ON configuration_versions(kind,configuration_key,audience,version_number DESC);
CREATE INDEX idx_configuration_versions_created ON configuration_versions(created_at DESC,id DESC);
CREATE INDEX idx_configuration_tests_version ON configuration_test_results(configuration_version_id,sequence_no DESC);
CREATE INDEX idx_configuration_activations_version ON configuration_activations(configuration_version_id,sequence_no DESC);

CREATE OR REPLACE FUNCTION protect_versioned_configuration_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'configuration records are immutable';
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION protect_versioned_configuration_append_only() FROM PUBLIC;

CREATE TRIGGER trg_configuration_versions_immutable BEFORE UPDATE OR DELETE ON configuration_versions
FOR EACH ROW EXECUTE FUNCTION protect_versioned_configuration_append_only();
CREATE TRIGGER trg_configuration_tests_immutable BEFORE UPDATE OR DELETE ON configuration_test_results
FOR EACH ROW EXECUTE FUNCTION protect_versioned_configuration_append_only();
CREATE TRIGGER trg_configuration_approvals_immutable BEFORE UPDATE OR DELETE ON configuration_approvals
FOR EACH ROW EXECUTE FUNCTION protect_versioned_configuration_append_only();
CREATE TRIGGER trg_configuration_schedules_immutable BEFORE UPDATE OR DELETE ON configuration_schedules
FOR EACH ROW EXECUTE FUNCTION protect_versioned_configuration_append_only();
CREATE TRIGGER trg_configuration_activations_immutable BEFORE UPDATE OR DELETE ON configuration_activations
FOR EACH ROW EXECUTE FUNCTION protect_versioned_configuration_append_only();

WITH synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'bootstrap-role-permission-' || md5(identity.role_id || ':' || permission.key),
    identity.role_id,
    permission.key,
    'PLATFORM',
    '[]'::jsonb
  FROM system_role_identities AS identity
  JOIN permission_definitions AS permission ON permission.application_id=identity.application_id AND permission.status='active'
  WHERE identity.system_key='bootstrap_admin' AND permission.key LIKE 'maint.configuration_versions.%'
  ON CONFLICT(role_id,permission_key) DO UPDATE SET scope='PLATFORM',scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0069-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.bootstrap_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object('permissionKey',permission_key,'scope','PLATFORM','migration','0069_versioned_configuration_framework')::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;

REVOKE ALL ON configuration_versions,configuration_test_results,configuration_approvals,configuration_schedules,configuration_activations FROM PUBLIC;
REVOKE ALL ON SEQUENCE configuration_test_results_sequence_no_seq,configuration_activations_sequence_no_seq FROM PUBLIC;
